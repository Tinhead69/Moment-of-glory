import { MODULE_ID, isEnabled } from "./settings.js";
import { considerWorkflow } from "./moment-of-glory.js";

/** @type {Map<string, { oldHP: number, newHP: number|null, amount: number, options: object, at: number }>} */
const pendingByTarget = new Map();
/** @type {Map<string, number>} actorUuid → HP before an update */
const hpBeforeUpdate = new Map();
const PENDING_TTL_MS = 5000;

function prunePending() {
  const now = Date.now();
  for (const [uuid, entry] of pendingByTarget) {
    if (now - entry.at > PENDING_TTL_MS) pendingByTarget.delete(uuid);
  }
}

/**
 * @param {unknown} ref
 * @returns {Item|null}
 */
function resolveItem(ref) {
  if (!ref) return null;
  if (ref.documentName === "Item") return ref;
  // dnd5e Activity documents expose `.item`
  if (ref.item?.documentName === "Item") return ref.item;
  if (ref.parent?.documentName === "Item") return ref.parent;
  if (typeof ref === "string") {
    try {
      const doc = fromUuidSync?.(ref);
      if (!doc) return null;
      if (doc.documentName === "Item") return doc;
      if (doc.item?.documentName === "Item") return doc.item;
      if (doc.parent?.documentName === "Item") return doc.parent;
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * @param {unknown} ref
 * @returns {Actor|null}
 */
function resolveActor(ref) {
  if (!ref) return null;
  if (ref.documentName === "Actor") return ref;
  if (ref.actor?.documentName === "Actor") return ref.actor;
  if (ref.parent?.actor?.documentName === "Actor") return ref.parent.actor;
  if (typeof ref === "string") {
    try {
      const doc = fromUuidSync?.(ref);
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor?.documentName === "Actor") return doc.actor;
      if (doc?.parent?.actor?.documentName === "Actor") return doc.parent.actor;
    } catch (_) { /* ignore */ }
    return game.actors.get(ref) || null;
  }
  return null;
}

/**
 * Best-effort attacker when damage options / chat are sparse.
 * @param {Actor|null} target
 * @returns {Actor|null}
 */
function fallbackAttacker(target) {
  const combatant = game.combat?.combatant?.actor;
  if (combatant && combatant.uuid !== target?.uuid) return combatant;

  const controlled = canvas.tokens?.controlled?.[0]?.actor;
  if (controlled && controlled.uuid !== target?.uuid) return controlled;

  if (game.user?.character && game.user.character.uuid !== target?.uuid) {
    return game.user.character;
  }
  return null;
}

/**
 * Pull attacker + weapon from damage options and recent chat cards.
 * @param {object} options
 * @param {Actor|null} [target]
 * @returns {{ attacker: Actor|null, item: Item|null, weaponName: string }}
 */
function resolveAttackContext(options = {}, target = null) {
  const origin = options.origin
    || options.dnd5e?.origin
    || options.dnd5e?.item
    || options.item;

  let item = resolveItem(options.item)
    || resolveItem(options.dnd5e?.item)
    || resolveItem(origin)
    || resolveItem(options.from);

  let attacker = resolveActor(options.actor)
    || resolveActor(options.sourceActor)
    || resolveActor(options.dnd5e?.actor)
    || resolveActor(origin)
    || resolveActor(item?.actor);

  const messageId = options.messageId
    || options.dnd5e?.messageId
    || options.dnd5e?.context?.messageId;
  if (messageId) {
    const msg = game.messages.get(messageId);
    if (msg) {
      if (!attacker && msg.speaker?.actor) {
        attacker = game.actors.get(msg.speaker.actor) || null;
      }
      const itemUuid = msg.flags?.dnd5e?.item?.uuid
        || msg.flags?.dnd5e?.use?.itemUuid
        || msg.flags?.dnd5e?.itemUuid;
      if (!item && itemUuid) item = resolveItem(itemUuid);
    }
  }

  if (!item || !attacker) {
    const recent = Array.from(game.messages ?? []).slice(-16).reverse();
    for (const msg of recent) {
      // Skip broken Midi leftovers that never initialized.
      if (String(msg.type || "").startsWith("midi-qol")) continue;

      const speakerActor = msg.speaker?.actor ? game.actors.get(msg.speaker.actor) : null;
      const itemUuid = msg.flags?.dnd5e?.item?.uuid
        || msg.flags?.dnd5e?.use?.itemUuid
        || msg.flags?.dnd5e?.itemUuid;
      const msgItem = itemUuid ? resolveItem(itemUuid) : null;
      const looksLikeAttack = Boolean(
        msgItem
        || msg.flags?.dnd5e?.roll?.type === "damage"
        || msg.flags?.dnd5e?.roll?.type === "attack"
        || msg.flags?.dnd5e?.targets
        || msg.rolls?.some?.((r) => r?.options?.type === "damage" || r?.isDamageRoll)
      );
      if (!looksLikeAttack) continue;
      if (!attacker && speakerActor && speakerActor.uuid !== target?.uuid) attacker = speakerActor;
      if (!item && msgItem) item = msgItem;
      if (attacker && item) break;
    }
  }

  if (!attacker) attacker = fallbackAttacker(target);

  const weaponName = item?.name || "your attack";
  return { attacker, item, weaponName };
}

/**
 * Deliver a detected kill to the GM (local or via socket).
 * @param {Actor} target
 * @param {object} ctx
 */
async function deliverKill(target, ctx = {}) {
  if (!target || !isEnabled()) return;

  const oldHP = ctx.oldHP;
  const newHP = ctx.newHP ?? Number(target.system?.attributes?.hp?.value ?? 0);
  if (newHP > 0) return;
  if (oldHP !== undefined && Number(oldHP) <= 0) return;

  const { attacker, item, weaponName } = resolveAttackContext(ctx.options || {}, target);
  const payload = {
    type: "killDetected",
    targetUuid: target.uuid,
    attackerUuid: attacker?.uuid || null,
    itemUuid: item?.uuid || null,
    weaponName,
    oldHP,
    newHP,
    amount: ctx.amount || 0
  };

  if (game.user?.isGM) {
    await considerKillPayload(payload);
    return;
  }

  // Players who apply damage see the hooks locally — forward to GM.
  game.socket.emit(`module.${MODULE_ID}`, payload);
  console.log(`${MODULE_ID} | Kill detected locally; forwarded to GM`, payload);
}

/**
 * GM-side entry for a kill payload (local applyDamage or socket).
 * @param {object} payload
 */
export async function considerKillPayload(payload) {
  if (!game.user?.isGM || !isEnabled()) return;

  const target = resolveActor(payload.targetUuid);
  if (!target) {
    console.warn(`${MODULE_ID} | kill payload missing target`, payload);
    return;
  }

  const attacker = resolveActor(payload.attackerUuid) || fallbackAttacker(target);
  const item = resolveItem(payload.itemUuid);
  const weaponName = payload.weaponName || item?.name || "your attack";

  if (!attacker) {
    console.warn(`${MODULE_ID} | Kill detected but no attacker resolved for`, target.name);
    return;
  }

  await considerWorkflow(
    {
      actor: attacker,
      item,
      itemName: weaponName,
      targets: [target],
      damageList: [{
        actorUuid: target.uuid,
        oldHP: payload.oldHP,
        newHP: payload.newHP,
        hpDamage: payload.amount
      }]
    },
    {
      target,
      attacker,
      item,
      itemName: weaponName,
      weaponName,
      oldHP: payload.oldHP,
      newHP: payload.newHP,
      totalDamage: payload.amount
    }
  );
}

/**
 * Register dnd5e-native damage hooks used when Midi-QOL is not active.
 */
export function registerFallbackDamageHooks() {
  // Capture HP before application so we know it was a fresh drop to 0.
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => {
    if (!isEnabled()) return;
    if (!actor?.uuid || !updates) return;

    const oldHP = Number(actor.system?.attributes?.hp?.value ?? NaN);
    const newHP = updates["system.attributes.hp.value"];
    if (!Number.isFinite(oldHP)) return;

    prunePending();
    pendingByTarget.set(actor.uuid, {
      oldHP,
      newHP: newHP !== undefined ? Number(newHP) : null,
      amount: Number(amount) || 0,
      options: options || {},
      at: Date.now()
    });
  });

  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
    if (!isEnabled()) return;
    const target = actor?.documentName === "Actor" ? actor : null;
    if (!target) return;

    prunePending();
    const pending = pendingByTarget.get(target.uuid);
    pendingByTarget.delete(target.uuid);

    const oldHP = pending?.oldHP;
    const newHP = pending?.newHP ?? Number(target.system?.attributes?.hp?.value ?? 0);
    const dmg = pending?.amount ?? (Number(amount) || 0);

    // Healing: ignore when HP didn't fall to 0.
    if (dmg < 0 && newHP > 0) return;
    if (newHP > 0) return;
    if (oldHP !== undefined && Number(oldHP) <= 0) return;

    deliverKill(target, {
      oldHP,
      newHP,
      amount: Math.abs(dmg),
      options: pending?.options || options || {}
    }).catch((err) => {
      console.error(`${MODULE_ID} | fallback applyDamage failed`, err);
    });
  });

  // Older / alternate hook name used in some dnd5e builds.
  Hooks.on("dnd5e.damageActor", (actor, amount, options) => {
    if (!isEnabled()) return;
    const target = actor?.documentName === "Actor" ? actor : null;
    if (!target) return;

    const newHP = Number(target.system?.attributes?.hp?.value ?? 0);
    if (newHP > 0) return;

    deliverKill(target, {
      oldHP: undefined,
      newHP,
      amount: Number(amount) || 0,
      options: options || {}
    }).catch((err) => {
      console.error(`${MODULE_ID} | fallback damageActor failed`, err);
    });
  });

  // Track HP before any actor update (covers bar edits / edge paths).
  Hooks.on("preUpdateActor", (actor, changed) => {
    if (!isEnabled()) return;
    const newHP = foundry.utils.getProperty(changed, "system.attributes.hp.value");
    if (newHP === undefined) return;
    hpBeforeUpdate.set(actor.uuid, Number(actor.system?.attributes?.hp?.value ?? NaN));
  });

  // Last-resort on GM: HP updates that skipped applyDamage hooks.
  Hooks.on("updateActor", (actor, changed) => {
    if (!isEnabled() || !game.user?.isGM) return;

    const newHP = foundry.utils.getProperty(changed, "system.attributes.hp.value");
    if (newHP === undefined) return;
    if (Number(newHP) > 0) return;

    const oldHP = hpBeforeUpdate.get(actor.uuid);
    hpBeforeUpdate.delete(actor.uuid);

    // Prefer applyDamage path when it just ran on this client.
    prunePending();
    if (pendingByTarget.has(actor.uuid)) return;
    if (oldHP !== undefined && Number(oldHP) <= 0) return;

    // Small delay so a player's socket (richer attacker context) can win the race.
    setTimeout(() => {
      deliverKill(actor, {
        oldHP,
        newHP: Number(newHP),
        amount: 0,
        options: {}
      }).catch((err) => {
        console.error(`${MODULE_ID} | fallback updateActor failed`, err);
      });
    }, 150);
  });

  console.log(`${MODULE_ID} | dnd5e damage fallback registered (no Midi-QOL required)`);
}
