import { MODULE_ID, hostilesOnly, ignorePCs, isEnabled } from "./settings.js";
import { fromUuidSafe, resolveActor, isCoordinator, isFreshKill } from "./compatibility.js";

const { DialogV2 } = foundry.applications.api;

/** Prevent double prompts for the same target in a short window. */
const recentTargets = new Map();
const inFlightTargets = new Set();
const DEDUPE_MS = 4000;

/**
 * @param {Actor} actor
 * @returns {boolean}
 */
function isHostileTarget(actor) {
  if (!actor) return false;
  const token = actor.getActiveTokens?.(true)?.[0] ?? actor.token;
  const disposition = token?.document?.disposition ?? token?.disposition ?? actor.prototypeToken?.disposition;
  if (disposition !== undefined && disposition !== null) {
    return Number(disposition) <= CONST.TOKEN_DISPOSITIONS.HOSTILE;
  }
  return actor.type === "npc";
}

/**
 * @param {Actor} actor
 * @returns {boolean}
 */
function isPlayerCharacter(actor) {
  return actor?.type === "character" && actor.hasPlayerOwner;
}

/**
 * @param {Actor} target
 * @returns {boolean}
 */
function shouldConsiderTarget(target) {
  if (!target) return false;
  if (ignorePCs() && isPlayerCharacter(target)) return false;
  if (hostilesOnly() && !isHostileTarget(target)) return false;
  return true;
}

/**
 * @param {string} targetUuid
 * @returns {boolean} true if we should skip (already handled)
 */
function isDuplicate(targetUuid) {
  const now = Date.now();
  for (const [uuid, ts] of recentTargets) {
    if (now - ts > DEDUPE_MS) recentTargets.delete(uuid);
  }
  if (inFlightTargets.has(targetUuid) || recentTargets.has(targetUuid)) return true;
  recentTargets.set(targetUuid, now);
  return false;
}

/**
 * Resolve the weapon / item / spell name used for the finishing blow.
 * @param {object} workflow
 * @param {object} [detail]
 * @returns {string}
 */
function resolveWeaponName(workflow, detail = {}) {
  const item = workflow?.item
    || detail?.item
    || (detail?.itemUuid && fromUuidSafe(detail.itemUuid))
    || null;

  const name = detail?.weaponName
    || item?.name
    || workflow?.itemName
    || detail?.itemName
    || workflow?.ammoName;

  if (name) return String(name);

  if (item?.type === "spell") return item.name || "a spell";
  if (item?.type === "feat") return item.name || "a feature";

  return "your attack";
}

/**
 * Did this damage application reduce the target to 0 HP (or below)?
 * @param {Actor} target
 * @param {object} [detail]
 * @returns {boolean}
 */
function wasReducedToZero(target, detail = {}) {
  const hp = target.system?.attributes?.hp;
  if (!hp) return false;

  const value = Number(hp.value ?? 0);
  if (value > 0) return false;

  const oldHP = detail.oldHP ?? detail.hpOld ?? detail.previousHp;
  const newHP = detail.newHP ?? detail.hpNew ?? detail.hp;
  if (oldHP !== undefined) {
    return isFreshKill(oldHP, newHP ?? value);
  }

  const start = detail.startingHP ?? detail.hpValue;
  const total = detail.totalDamage ?? detail.damageTotal ?? detail.appliedDamage;
  if (start !== undefined && total !== undefined) {
    return Number(start) > 0 && Number(start) - Number(total) <= 0;
  }

  // Being at zero is insufficient: the target may have died on an earlier turn.
  // Core HP tracking covers workflows which do not provide a before/after pair.
  return false;
}

/**
 * Pick the attacking actor from a Midi workflow / damage context.
 * @param {object} workflow
 * @param {object} [detail]
 * @returns {Actor|null}
 */
function resolveAttacker(workflow, detail = {}) {
  const primary = resolveActor(workflow?.actor)
    || resolveActor(detail?.actor)
    || resolveActor(detail?.attacker)
    || resolveActor(detail?.item?.actor)
    || resolveActor(workflow?.item?.actor);

  if (primary) return primary;

  const combatant = resolveActor(game.combat?.combatant?.actor);
  if (combatant) return combatant;

  return resolveActor(canvas.tokens?.controlled?.[0]?.actor)
    || resolveActor(game.user?.character)
    || null;
}

/**
 * Ask the GM whether to offer a Moment of Glory.
 * @param {{ attacker: Actor, target: Actor, weaponName: string }} ctx
 * @returns {Promise<boolean>}
 */
async function promptGM({ attacker, target, weaponName }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.GM.PromptContent", {
    attacker: attacker?.name ?? "Unknown",
    target: target?.name ?? "Unknown",
    weapon: weaponName || "their attack"
  });

  try {
    const result = await DialogV2.wait({
      window: {
        title: game.i18n.localize("MOMENT_OF_GLORY.GM.PromptTitle"),
        icon: "fas fa-crown"
      },
      classes: ["moment-of-glory-dialog"],
      position: { width: 480 },
      content: `<div class="mog-prompt">${content}</div>`,
      buttons: [
        {
          action: "offer",
          label: game.i18n.localize("MOMENT_OF_GLORY.GM.Offer"),
          icon: "fas fa-star",
          default: true,
          callback: () => true
        },
        {
          action: "decline",
          label: game.i18n.localize("MOMENT_OF_GLORY.GM.Decline"),
          icon: "fas fa-times",
          callback: () => false
        }
      ],
      rejectClose: false
    });
    return result === true;
  } catch (_) {
    return false;
  }
}

/**
 * Spotlight prompt for the player — roleplay aloud, no typing.
 * @param {{ attacker: Actor, target: Actor, weaponName: string }} ctx
 * @returns {Promise<boolean>} true if they seize the moment
 */
async function promptPlayer({ attacker, target, weaponName }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.Player.PromptContent", {
    target: target?.name ?? "the foe",
    weapon: weaponName || "your attack"
  });

  try {
    const result = await DialogV2.wait({
      window: {
        title: game.i18n.localize("MOMENT_OF_GLORY.Player.PromptTitle"),
        icon: "fas fa-scroll"
      },
      classes: ["moment-of-glory-dialog"],
      position: { width: 480 },
      content: `
        <div class="mog-prompt">${content}</div>
        <p class="mog-hint">${game.i18n.localize("MOMENT_OF_GLORY.Player.Hint")}</p>
      `,
      buttons: [
        {
          action: "seize",
          label: game.i18n.localize("MOMENT_OF_GLORY.Player.Submit"),
          icon: "fas fa-check",
          default: true,
          callback: () => true
        },
        {
          action: "skip",
          label: game.i18n.localize("MOMENT_OF_GLORY.Player.Skip"),
          icon: "fas fa-forward",
          callback: () => false
        }
      ],
      rejectClose: false
    });
    return result === true;
  } catch (_) {
    return false;
  }
}

/**
 * Post that a Moment of Glory was taken (table RP; no typed text).
 * @param {{ attacker: Actor, target: Actor, weaponName: string }} ctx
 */
async function announceMoment({ attacker, target, weaponName }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.Chat.Announcement", {
    attacker: attacker?.name ?? "Unknown",
    target: target?.name ?? "Unknown",
    weapon: weaponName || "their attack"
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: `<div class="moment-of-glory-card">${content}</div>`,
    flavor: game.i18n.localize("MOMENT_OF_GLORY.Title")
  });
}

/**
 * Find a User who should receive the player prompt for this attacker.
 * @param {Actor} attacker
 * @returns {User|null}
 */
function findPlayerUser(attacker) {
  if (!attacker) return null;
  const owners = game.users.filter((u) => u.active && !u.isGM && attacker.testUserPermission?.(u, "OWNER"));
  if (owners.length) return owners[0];
  if (attacker.hasPlayerOwner) {
    return game.users.find((u) => u.character?.id === attacker.id) || null;
  }
  return null;
}

const SKULL_ICON = "icons/svg/skull.svg";

/** Let each Foundry/system version create its own valid condition data. */
async function markCreatureDead(target) {
  if (!target || !isCoordinator()) return;
  try {
    await target.toggleStatusEffect("dead", { active: true, overlay: true });
    // Also promote an existing dead condition to an overlay, without creating duplicates.
    const effect = target.effects?.find(e => e.statuses?.has?.("dead") || e.statuses?.includes?.("dead"));
    if (effect) await effect.update({ img: SKULL_ICON, "flags.core.overlay": true });
  } catch (err) {
    console.warn(MODULE_ID + " | Failed to mark defeated creature", err);
  }
}

/**
 * Run the full GM → player Moment of Glory flow (GM client orchestrates).
 * @param {{ attacker: Actor, target: Actor, weaponName?: string }} ctx
 */
export async function runMomentOfGloryFlow({ attacker, target, weaponName = "your attack" }) {
  if (!isCoordinator()) return;
  if (!isEnabled()) return;
  if (!attacker || !target) return;
  if (!shouldConsiderTarget(target)) return;
  const targetKey = target.uuid || target.id;
  if (isDuplicate(targetKey)) return;
  inFlightTargets.add(targetKey);
  try {

    // Creature is at 0 HP — show skull & crossbones on the token.
    await markCreatureDead(target);

    const offered = await promptGM({ attacker, target, weaponName });
    if (!offered) {
      ui.notifications?.info(game.i18n.localize("MOMENT_OF_GLORY.Notify.Declined"));
      return;
    }

    const playerUser = findPlayerUser(attacker);
    let seized = false;

    if (playerUser && playerUser.active) {
      seized = await requestPlayerSpotlight(playerUser.id, {
        attackerUuid: attacker.uuid,
        targetUuid: target.uuid,
        attackerName: attacker.name,
        targetName: target.name,
        weaponName
      });
    } else {
      seized = await promptPlayer({ attacker, target, weaponName });
    }

    if (seized) {
      await announceMoment({ attacker, target, weaponName });
    } else {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: attacker }),
        content: game.i18n.format("MOMENT_OF_GLORY.Chat.Skipped", {
          attacker: attacker.name,
          target: target.name
        })
      });
    }
  } finally {
    inFlightTargets.delete(targetKey);
    recentTargets.set(targetKey, Date.now());
  }
}

/**
 * Socket: GM asks a player to take their Moment of Glory (spoken RP).
 * @param {string} userId
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
function requestPlayerSpotlight(userId, payload) {
  return new Promise((resolve) => {
    const requestId = foundry.utils.randomID();
    const timeout = setTimeout(() => {
      Hooks.off("moment-of-glory.playerResponse", handler);
      resolve(false);
    }, 120000);

    function handler(response) {
      if (response?.requestId !== requestId) return;
      clearTimeout(timeout);
      Hooks.off("moment-of-glory.playerResponse", handler);
      resolve(Boolean(response.seized));
    }

    Hooks.on("moment-of-glory.playerResponse", handler);

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "offerPlayer",
      requestId,
      userId,
      ...payload
    });

    const user = game.users.get(userId);
    ui.notifications?.info(game.i18n.format("MOMENT_OF_GLORY.Notify.WaitingOnPlayer", {
      player: user?.name || "player"
    }));
  });
}

/**
 * Handle socket messages on each client.
 * @param {object} data
 */
export async function handleSocket(data) {
  if (!data?.type) return;

  if (data.type === "killDetected") {
    if (!isCoordinator()) return;
    const { considerKillPayload } = await import("./fallback-damage.js");
    await considerKillPayload(data);
    return;
  }

  if (data.type === "offerPlayer") {
    if (game.user.id !== data.userId) return;
    ui.notifications?.info(game.i18n.localize("MOMENT_OF_GLORY.Notify.Offered"));

    const attacker = resolveActor(data.attackerUuid);
    const target = resolveActor(data.targetUuid);
    const seized = await promptPlayer({
      attacker: attacker || { name: data.attackerName },
      target: target || { name: data.targetName },
      weaponName: data.weaponName || "your attack"
    });

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "playerResponse",
      requestId: data.requestId,
      seized
    });
    return;
  }

  if (data.type === "playerResponse") {
    if (!isCoordinator()) return;
    Hooks.callAll("moment-of-glory.playerResponse", data);
  }
}

/**
 * Entry point from Midi-QOL / damage hooks.
 * @param {object} workflow
 * @param {object} [detail]
 */
export async function considerWorkflow(workflow, detail = {}) {
  if (!isEnabled()) return;
  if (!isCoordinator()) return;

  const attacker = resolveAttacker(workflow, detail);
  const weaponName = resolveWeaponName(workflow, detail);
  const targets = [];

  const damageList = workflow?.damageList || detail?.damageList || [];
  if (Array.isArray(damageList) && damageList.length) {
    for (const entry of damageList) {
      const target = resolveActor(entry.actorUuid || entry.actorId || entry.targetUuid || entry.actor);
      if (!target) continue;
      const oldHP = entry.oldHP ?? entry.hpOld;
      const newHP = entry.newHP ?? (entry.hpDamage !== undefined
        ? Number(oldHP ?? 0) - Number(entry.hpDamage)
        : undefined);
      const zero = wasReducedToZero(target, {
        oldHP,
        newHP,
        startingHP: oldHP,
        totalDamage: entry.hpDamage ?? entry.appliedDamage
      });
      if (zero) targets.push(target);
    }
  }

  if (!targets.length && !damageList.length && !detail?.target) {
    const tokenTargets = workflow?.targets || detail?.targets;
    if (tokenTargets) {
      const list = typeof tokenTargets[Symbol.iterator] === "function"
        ? Array.from(tokenTargets)
        : [];
      for (const t of list) {
        const actor = resolveActor(t?.actor || t);
        if (actor && wasReducedToZero(actor, detail)) {
          targets.push(actor);
        }
      }
    }
  }

  if (!targets.length && detail?.target) {
    const actor = resolveActor(detail.target);
    if (actor && wasReducedToZero(actor, detail)) targets.push(actor);
  }

  const unique = new Map();
  for (const t of targets) {
    if (t?.uuid) unique.set(t.uuid, t);
  }

  for (const target of unique.values()) {
    if (!shouldConsiderTarget(target)) continue;
    await runMomentOfGloryFlow({ attacker, target, weaponName });
  }
}
