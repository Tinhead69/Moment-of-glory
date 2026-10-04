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
  // Token disposition: HOSTILE = -1
  const token = actor.getActiveTokens?.(true)?.[0] ?? actor.token;
  const disposition = token?.document?.disposition ?? actor.prototypeToken?.disposition;
  if (disposition !== undefined && disposition !== null) {
    return Number(disposition) <= CONST.TOKEN_DISPOSITIONS.HOSTILE;
  }
  // Fallback: NPCs are treated as valid when disposition is missing.
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

  // Prefer explicit before/after when Midi provides them.
  const oldHP = detail.oldHP ?? detail.hpOld ?? detail.previousHp;
  const newHP = detail.newHP ?? detail.hpNew ?? detail.hp;
  if (oldHP !== undefined && newHP !== undefined) {
    return Number(oldHP) > 0 && Number(newHP) <= 0;
  }

  // Midi sometimes exposes total damage + starting HP.
  const start = detail.startingHP ?? detail.hpValue;
  const total = detail.totalDamage ?? detail.damageTotal ?? detail.appliedDamage;
  if (start !== undefined && total !== undefined) {
    return Number(start) > 0 && Number(start) - Number(total) <= 0;
  }

  // Last resort: currently at 0 after a damage event (deduped per target).
  return value <= 0;
}

/**
 * Pick the attacking actor from a Midi workflow / damage context.
 * @param {object} workflow
 * @param {object} [detail]
 * @returns {Actor|null}
 */
function resolveAttacker(workflow, detail = {}) {
  return resolveActor(workflow?.actor)
    || resolveActor(detail?.actor)
    || resolveActor(detail?.attacker)
    || resolveActor(canvas.tokens?.controlled?.[0]?.actor)
    || null;
}

/**
 * Ask the GM whether to offer a Moment of Glory.
 * @param {{ attacker: Actor, target: Actor }} ctx
 * @returns {Promise<boolean>}
 */
async function promptGM({ attacker, target }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.GM.PromptContent", {
    attacker: attacker?.name ?? "Unknown",
    target: target?.name ?? "Unknown"
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
 * Ask the player (or GM controlling them) to describe the finishing blow.
 * @param {{ attacker: Actor, target: Actor }} ctx
 * @returns {Promise<string|null>}
 */
async function promptPlayer({ attacker, target }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.Player.PromptContent", {
    target: target?.name ?? "the foe"
  });
  const placeholder = game.i18n.localize("MOMENT_OF_GLORY.Player.Placeholder");

  let description = null;
  try {
    await DialogV2.wait({
      window: {
        title: game.i18n.localize("MOMENT_OF_GLORY.Player.PromptTitle"),
        icon: "fas fa-scroll"
      },
      classes: ["moment-of-glory-dialog"],
      position: { width: 520 },
      content: `
        <div class="mog-prompt">${content}</div>
        <textarea class="mog-description" name="mog-description" placeholder="${placeholder}"></textarea>
        <p class="mog-hint">Keep it short — this is a spotlight moment, not a novel.</p>
      `,
      buttons: [
        {
          action: "submit",
          label: game.i18n.localize("MOMENT_OF_GLORY.Player.Submit"),
          icon: "fas fa-check",
          default: true,
          callback: (_event, button) => {
            const root = button.form
              || button.closest?.(".window-content, .application, form")
              || document;
            const area = root.querySelector?.('textarea[name="mog-description"]');
            description = String(area?.value || "").trim();
            return description;
          }
        },
        {
          action: "skip",
          label: game.i18n.localize("MOMENT_OF_GLORY.Player.Skip"),
          icon: "fas fa-forward",
          callback: () => {
            description = null;
            return null;
          }
        }
      ],
      rejectClose: false
    });
  } catch (_) {
    return null;
  }
  return description;
}

/**
 * Post the Moment of Glory to chat.
 * @param {{ attacker: Actor, target: Actor, description: string }} ctx
 */
async function announceMoment({ attacker, target, description }) {
  const content = game.i18n.format("MOMENT_OF_GLORY.Chat.Announcement", {
    attacker: attacker?.name ?? "Unknown",
    target: target?.name ?? "Unknown",
    description: foundry.utils.escapeHTML?.(description) || description
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

/**
 * Run the full GM → player Moment of Glory flow (GM client orchestrates).
 * @param {{ attacker: Actor, target: Actor }} ctx
 */
export async function runMomentOfGloryFlow({ attacker, target }) {
  if (!game.user?.isGM) return;
  if (!isEnabled()) return;
  if (!attacker || !target) return;
  if (!shouldConsiderTarget(target)) return;
  if (isDuplicate(target.uuid || target.id)) return;

  const offered = await promptGM({ attacker, target });
  if (!offered) {
    ui.notifications?.info(game.i18n.localize("MOMENT_OF_GLORY.Notify.Declined"));
    return;
  }

  // Ask the owning player if present; otherwise the GM fills in / skip.
  const playerUser = findPlayerUser(attacker);
  let description = null;

  if (playerUser && playerUser.active) {
    // Request the player client to show the dialog via socket.
    description = await requestPlayerDescription(playerUser.id, {
      attackerUuid: attacker.uuid,
      targetUuid: target.uuid,
      attackerName: attacker.name,
      targetName: target.name
    });
  } else {
    // GM-controlled attacker (or offline player): prompt on GM client.
    description = await promptPlayer({ attacker, target });
  }

  if (description) {
    await announceMoment({ attacker, target, description });
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
 * Socket: GM asks a player to describe their Moment of Glory.
 * @param {string} userId
 * @param {object} payload
 * @returns {Promise<string|null>}
 */
function requestPlayerDescription(userId, payload) {
  return new Promise((resolve) => {
    const requestId = foundry.utils.randomID();
    const timeout = setTimeout(() => {
      Hooks.off("moment-of-glory.playerResponse", handler);
      resolve(null);
    }, 120000);

    function handler(response) {
      if (response?.requestId !== requestId) return;
      clearTimeout(timeout);
      Hooks.off("moment-of-glory.playerResponse", handler);
      resolve(response.description ?? null);
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

  if (data.type === "offerPlayer") {
    if (game.user.id !== data.userId) return;
    ui.notifications?.info(game.i18n.localize("MOMENT_OF_GLORY.Notify.Offered"));

    const attacker = resolveActor(data.attackerUuid);
    const target = resolveActor(data.targetUuid);
    const description = await promptPlayer({
      attacker: attacker || { name: data.attackerName },
      target: target || { name: data.targetName }
    });

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "playerResponse",
      requestId: data.requestId,
      description
    });
    return;
  }

  if (data.type === "playerResponse") {
    // Only the GM who issued the request needs this.
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
  const targets = [];

  // Midi workflow damageList is the richest source.
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
      // Also accept "currently at 0 after this workflow hit them".
      const atZero = Number(target.system?.attributes?.hp?.value ?? 1) <= 0;
      if (zero || atZero) targets.push(target);
    }
  }

  // Fallback: workflow.targets / failed targets tokens
  if (!targets.length) {
    const tokenTargets = workflow?.targets || detail?.targets;
    if (tokenTargets) {
      for (const t of tokenTargets) {
        const actor = resolveActor(t);
        if (actor && Number(actor.system?.attributes?.hp?.value ?? 1) <= 0) {
          targets.push(actor);
        }
      }
    }
  }

  // Single-target detail fallback
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
    // Fire sequentially so the GM isn't buried in dialogs.
    await runMomentOfGloryFlow({ attacker, target });
  }
}
