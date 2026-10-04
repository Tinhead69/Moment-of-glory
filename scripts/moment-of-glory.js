import { MODULE_ID, hostilesOnly, ignorePCs, isEnabled } from "./settings.js";

const { DialogV2 } = foundry.applications.api;

/** Prevent double prompts for the same target in a short window. */
const recentTargets = new Map();
const DEDUPE_MS = 4000;

/**
 * @param {Actor} actor
 * @returns {boolean}
 */
function isHostileTarget(actor) {
  if (!actor) return false;
  const token = actor.getActiveTokens?.(true)?.[0] ?? actor.token;
  const disposition = token?.document?.disposition ?? actor.prototypeToken?.disposition;
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
  if (recentTargets.has(targetUuid)) return true;
  recentTargets.set(targetUuid, now);
  return false;
}

/**
 * Resolve an Actor from assorted Midi / damage payload shapes.
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
  }
  return null;
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
    || (detail?.itemUuid && fromUuidSync?.(detail.itemUuid))
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
  if (oldHP !== undefined && newHP !== undefined) {
    return Number(oldHP) > 0 && Number(newHP) <= 0;
  }

  const start = detail.startingHP ?? detail.hpValue;
  const total = detail.totalDamage ?? detail.damageTotal ?? detail.appliedDamage;
  if (start !== undefined && total !== undefined) {
    return Number(start) > 0 && Number(start) - Number(total) <= 0;
  }

  return value <= 0;
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
  const owners = game.users.filter((u) => !u.isGM && attacker.testUserPermission?.(u, "OWNER"));
  if (owners.length) return owners[0];
  if (attacker.hasPlayerOwner) {
    return game.users.find((u) => u.character?.id === attacker.id) || null;
  }
  return null;
}

const SKULL_ICON = "icons/svg/skull.svg";

/**
 * @param {Actor} target
 * @returns {boolean}
 */
function actorHasDeadStatus(target) {
  return Boolean(target.effects?.some((effect) => {
    const statuses = effect.statuses;
    if (statuses instanceof Set) return statuses.has("dead");
    if (Array.isArray(statuses)) return statuses.includes("dead");
    return effect.flags?.core?.statusId === "dead"
      || effect.flags?.dnd5e?.statusId === "dead";
  }));
}

/**
 * @param {Actor} target
 * @returns {boolean}
 */
function actorHasSkullOverlayEffect(target) {
  return Boolean(target.effects?.some((effect) => {
    return effect.getFlag?.(MODULE_ID, "skullOverlay") === true
      || effect.flags?.[MODULE_ID]?.skullOverlay === true;
  }));
}

/**
 * Apply a large skull overlay centered on the creature's token(s).
 * Uses token.overlayEffect when available, plus an overlay ActiveEffect for v12/v13.
 * @param {Actor} target
 */
async function markCreatureDead(target) {
  if (!target || !game.user?.isGM) return;

  // 1) Classic token overlay (large, centered in the token square).
  const tokens = target.getActiveTokens?.(true) ?? [];
  for (const token of tokens) {
    try {
      const doc = token.document;
      if (doc.overlayEffect !== SKULL_ICON) {
        await doc.update({ overlayEffect: SKULL_ICON });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to set token.overlayEffect`, err);
    }
  }

  // 2) ActiveEffect marked as overlay (Foundry draws this large over the token).
  if (!actorHasSkullOverlayEffect(target)) {
    try {
      const effectData = {
        name: game.i18n.localize("MOMENT_OF_GLORY.Title") || "Dead",
        img: SKULL_ICON,
        icon: SKULL_ICON,
        statuses: ["dead"],
        flags: {
          core: { overlay: true },
          [MODULE_ID]: { skullOverlay: true }
        }
      };
      // Avoid duplicating an existing dead effect — update it to overlay instead.
      const existingDead = target.effects?.find((effect) => {
        const statuses = effect.statuses;
        if (statuses instanceof Set) return statuses.has("dead");
        if (Array.isArray(statuses)) return statuses.includes("dead");
        return false;
      });
      if (existingDead) {
        await existingDead.update({
          img: SKULL_ICON,
          icon: SKULL_ICON,
          "flags.core.overlay": true,
          [`flags.${MODULE_ID}.skullOverlay`]: true
        });
      } else {
        await target.createEmbeddedDocuments("ActiveEffect", [effectData]);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to create overlay ActiveEffect`, err);
      if (!actorHasDeadStatus(target) && typeof target.toggleStatusEffect === "function") {
        try {
          await target.toggleStatusEffect("dead", { active: true });
        } catch (err2) {
          console.warn(`${MODULE_ID} | toggleStatusEffect(dead) failed`, err2);
        }
      }
    }
  }
}

/**
 * Run the full GM → player Moment of Glory flow (GM client orchestrates).
 * @param {{ attacker: Actor, target: Actor, weaponName?: string }} ctx
 */
export async function runMomentOfGloryFlow({ attacker, target, weaponName = "your attack" }) {
  if (!game.user?.isGM) return;
  if (!isEnabled()) return;
  if (!attacker || !target) return;
  if (!shouldConsiderTarget(target)) return;
  if (isDuplicate(target.uuid || target.id)) return;

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
    if (!game.user?.isGM) return;
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
    if (!game.user?.isGM) return;
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
  if (!game.user?.isGM) return;

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
      const atZero = Number(target.system?.attributes?.hp?.value ?? 1) <= 0;
      if (zero || atZero) targets.push(target);
    }
  }

  if (!targets.length) {
    const tokenTargets = workflow?.targets || detail?.targets;
    if (tokenTargets) {
      const list = typeof tokenTargets[Symbol.iterator] === "function"
        ? Array.from(tokenTargets)
        : [];
      for (const t of list) {
        const actor = resolveActor(t?.actor || t);
        if (actor && Number(actor.system?.attributes?.hp?.value ?? 1) <= 0) {
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
