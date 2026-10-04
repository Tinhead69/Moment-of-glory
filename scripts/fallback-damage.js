import { MODULE_ID, isEnabled } from "./settings.js";
import { considerWorkflow } from "./moment-of-glory.js";

/** @type {Map<string, { oldHP: number, newHP: number|null, amount: number, options: object, at: number }>} */
const pendingByTarget = new Map();
const PENDING_TTL_MS = 5000;

function midiActive() {
  return Boolean(game.modules.get("midi-qol")?.active);
}

function prunePending() {
  const now = Date.now();
  for (const [uuid, entry] of pendingByTarget) {
    if (now - entry.at > PENDING_TTL_MS) pendingByTarget.delete(uuid);
  }
}

/**
 * Resolve an Item from uuid / object.
 * @param {unknown} ref
 * @returns {Item|null}
 */
function resolveItem(ref) {
  if (!ref) return null;
  if (ref.documentName === "Item") return ref;
  if (typeof ref === "string") {
    try {
      const doc = fromUuidSync?.(ref);
      return doc?.documentName === "Item" ? doc : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Resolve Actor from uuid / object / id.
 * @param {unknown} ref
 * @returns {Actor|null}
 */
function resolveActor(ref) {
  if (!ref) return null;
  if (ref.documentName === "Actor") return ref;
  if (ref.actor) return ref.actor;
  if (typeof ref === "string") {
    try {
      const doc = fromUuidSync?.(ref);
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor) return doc.actor;
    } catch (_) { /* ignore */ }
    return game.actors.get(ref) || null;
  }
  return null;
}

/**
 * Pull attacker + weapon from damage options and recent chat cards.
 * @param {object} options
 * @returns {{ attacker: Actor|null, item: Item|null, weaponName: string }}
 */
function resolveAttackContext(options = {}) {
  let item = resolveItem(options.item)
    || resolveItem(options.dnd5e?.item)
    || resolveItem(options.origin)
    || resolveItem(options.from);

  let attacker = resolveActor(options.actor)
    || resolveActor(options.sourceActor)
    || resolveActor(options.dnd5e?.actor)
    || resolveActor(options.origin?.actor)
    || resolveActor(item?.actor);

  // Activity / chat message linkage (dnd5e damage cards).
  const messageId = options.messageId || options.dnd5e?.messageId;
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

  // Scan recent messages for a damage/attack card from a plausible attacker.
  if (!item || !attacker) {
    const recent = Array.from(game.messages).slice(-12).reverse();
    for (const msg of recent) {
      const speakerActor = msg.speaker?.actor ? game.actors.get(msg.speaker.actor) : null;
      const itemUuid = msg.flags?.dnd5e?.item?.uuid
        || msg.flags?.dnd5e?.use?.itemUuid
        || msg.flags?.dnd5e?.itemUuid;
      const msgItem = itemUuid ? resolveItem(itemUuid) : null;
      const looksLikeAttack = Boolean(
        msgItem
        || msg.flags?.dnd5e?.roll?.type === "damage"
        || msg.flags?.dnd5e?.roll?.type === "attack"
        || msg.rolls?.some?.((r) => r?.options?.type === "damage" || r?.isDamageRoll)
      );
      if (!looksLikeAttack) continue;
      if (!attacker && speakerActor) attacker = speakerActor;
      if (!item && msgItem) item = msgItem;
      if (attacker && item) break;
    }
  }

  if (!attacker) {
    attacker = canvas.tokens?.controlled?.[0]?.actor || game.user?.character || null;
  }

  const weaponName = item?.name || "your attack";
  return { attacker, item, weaponName };
}

/**
 * Shared handler once we know a target hit 0 HP from damage.
 * @param {Actor} target
 * @param {object} ctx
 */
async function handleZeroHpKill(target, ctx = {}) {
  if (!target || !isEnabled() || !game.user?.isGM) return;
  if (midiActive()) return;

  const oldHP = ctx.oldHP;
  const newHP = ctx.newHP ?? Number(target.system?.attributes?.hp?.value ?? 0);
  if (newHP > 0) return;
  if (oldHP !== undefined && Number(oldHP) <= 0) return; // already down

  const { attacker, item, weaponName } = resolveAttackContext(ctx.options || {});

  await considerWorkflow(
    {
      actor: attacker,
      item,
      itemName: weaponName,
      targets: [target],
      damageList: [{
        actorUuid: target.uuid,
        oldHP,
        newHP,
        hpDamage: ctx.amount
      }]
    },
    {
      target,
      attacker,
      item,
      itemName: weaponName,
      weaponName,
      oldHP,
      newHP,
      totalDamage: ctx.amount
    }
  );
}

/**
 * Register dnd5e-native damage hooks used when Midi-QOL is not active.
 */
export function registerFallbackDamageHooks() {
  // Capture HP before application so we know it was a fresh drop to 0.
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => {
    if (!isEnabled() || !game.user?.isGM || midiActive()) return;
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
    if (!isEnabled() || !game.user?.isGM || midiActive()) return;
    const target = actor?.documentName === "Actor" ? actor : null;
    if (!target) return;

    prunePending();
    const pending = pendingByTarget.get(target.uuid);
    pendingByTarget.delete(target.uuid);

    const oldHP = pending?.oldHP;
    const newHP = pending?.newHP ?? Number(target.system?.attributes?.hp?.value ?? 0);
    const dmg = pending?.amount ?? Number(amount) || 0;

    // Healing / temp-only noise: ignore non-positive damage totals when HP didn't fall to 0.
    if (dmg < 0 && newHP > 0) return;

    handleZeroHpKill(target, {
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
    if (!isEnabled() || !game.user?.isGM || midiActive()) return;
    const target = actor?.documentName === "Actor" ? actor : null;
    if (!target) return;

    const newHP = Number(target.system?.attributes?.hp?.value ?? 0);
    if (newHP > 0) return;

    handleZeroHpKill(target, {
      oldHP: undefined,
      newHP,
      amount: Number(amount) || 0,
      options: options || {}
    }).catch((err) => {
      console.error(`${MODULE_ID} | fallback damageActor failed`, err);
    });
  });

  // Last-resort: HP updates from any source (manual sheet edits included).
  Hooks.on("updateActor", (actor, changed, _options, userId) => {
    if (!isEnabled() || !game.user?.isGM || midiActive()) return;
    if (game.user.id !== userId && !game.user.isGM) return;

    const newHP = changed?.system?.attributes?.hp?.value;
    if (newHP === undefined) return;
    if (Number(newHP) > 0) return;

    // Ignore if we already handled via applyDamage moments ago.
    prunePending();
    if (pendingByTarget.has(actor.uuid)) return;

    handleZeroHpKill(actor, {
      oldHP: undefined,
      newHP: Number(newHP),
      amount: 0,
      options: {}
    }).catch((err) => {
      console.error(`${MODULE_ID} | fallback updateActor failed`, err);
    });
  });

  console.log(`${MODULE_ID} | dnd5e damage fallback registered (no Midi-QOL required)`);
}
