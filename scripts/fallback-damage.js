import { MODULE_ID, isEnabled } from "./settings.js";
import { considerWorkflow } from "./moment-of-glory.js";
import { resolveActor, resolveItem, fallbackAttacker, resolveAttackContext, isCoordinator, hpValue, changedHP, isFreshKill } from "./compatibility.js";

const pendingByTarget = new Map();
const observedHP = new Map();
const PENDING_TTL_MS = 5000;

function prunePending() {
  for (const [uuid, entry] of pendingByTarget) {
    if (Date.now() - entry.at > PENDING_TTL_MS) pendingByTarget.delete(uuid);
  }
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
  if (!isFreshKill(oldHP, newHP) || hpValue(target) > 0) return;

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

  if (isCoordinator()) {
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
  if (!isCoordinator() || !isEnabled()) return;

  const target = resolveActor(payload.targetUuid);
  if (!target) {
    console.warn(`${MODULE_ID} | kill payload missing target`, payload);
    return;
  }

  if (!isFreshKill(payload.oldHP, payload.newHP) || hpValue(target) > 0) return;

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
  const remember = actor => { if (actor?.uuid) observedHP.set(actor.uuid, hpValue(actor)); };
  const seed = () => {
    observedHP.clear();
    for (const actor of game.actors) remember(actor);
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) remember(token.actor);
  };
  seed();
  Hooks.on("canvasReady", seed);
  Hooks.on("createActor", remember);
  Hooks.on("createToken", token => remember(token.actor));
  Hooks.on("deleteActor", actor => observedHP.delete(actor.uuid));
  Hooks.on("deleteToken", token => { if (token.actor?.isToken) observedHP.delete(token.actor.uuid); });

  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options = {}) => {
    if (!isEnabled() || !actor?.uuid || !updates) return;
    prunePending();
    pendingByTarget.set(actor.uuid, {
      oldHP: hpValue(actor), amount: Number(amount) || 0, options, at: Date.now()
    });
  });

  Hooks.on("dnd5e.applyDamage", (actor, amount, options = {}) => {
    if (!isEnabled() || !actor?.uuid) return;
    prunePending();
    const pending = pendingByTarget.get(actor.uuid);
    pendingByTarget.delete(actor.uuid);
    // Read committed HP: another hook may have changed or cancelled proposed updates.
    deliverKill(actor, {
      oldHP: pending?.oldHP, newHP: hpValue(actor),
      amount: pending?.amount ?? (Number(amount) || 0),
      options: { ...pending?.options, ...options }
    }).catch(err => console.error(MODULE_ID + " | applyDamage failed", err));
  });

  // Core document hooks cover older systems and manual HP edits, including updates
  // received from other users. Cache HP on every client, even when disabled.
  Hooks.on("preUpdateActor", actor => remember(actor));
  Hooks.on("updateActor", (actor, changed, options = {}) => {
    const next = changedHP(changed);
    if (next === undefined) return;
    const oldHP = observedHP.get(actor.uuid);
    remember(actor);
    if (!isEnabled() || !isCoordinator() || !isFreshKill(oldHP, next)) return;
    // Let the damage initiator send its exact item/message context first.
    setTimeout(() => {
      deliverKill(actor, { oldHP, newHP: hpValue(actor), options }).catch(err => {
        console.error(MODULE_ID + " | updateActor fallback failed", err);
      });
    }, 300);
  });
}
