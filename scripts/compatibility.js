/** API adapters shared by Foundry v13/v14 and legacy/current dnd5e. */
export function fromUuidSafe(uuid) {
  if (typeof uuid !== "string") return null;
  try {
    const lookup = globalThis.foundry?.utils?.fromUuidSync ?? globalThis.fromUuidSync;
    return lookup?.(uuid) ?? null;
  } catch (_) { return null; }
}

export function resolveItem(ref) {
  if (typeof ref === "string") ref = fromUuidSafe(ref);
  if (ref?.documentName === "Item") return ref;
  if (ref?.item?.documentName === "Item") return ref.item;
  if (ref?.parent?.documentName === "Item") return ref.parent;
  if (ref?.uuid) {
    const item = fromUuidSafe(ref.uuid);
    if (item?.documentName === "Item") return item;
  }
  return null;
}

export function resolveActor(ref) {
  if (typeof ref === "string") ref = fromUuidSafe(ref) ?? game.actors.get(ref);
  if (ref?.documentName === "Actor") return ref;
  return ref?.actor ?? ref?.parent?.actor ?? null;
}

/** Elect one connected GM so sockets and replicated updates do not prompt every GM. */
export function isCoordinator() {
  if (!game.user?.isGM) return false;
  const gm = game.users.activeGM
    ?? game.users.filter(u => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  return gm?.id === game.user.id;
}

export function fallbackAttacker(target) {
  return [game.combat?.combatant?.actor, globalThis.canvas?.tokens?.controlled?.[0]?.actor,
    game.user?.character].find(a => a && a.uuid !== target?.uuid) ?? null;
}

function messageContext(message) {
  if (typeof message === "string") message = game.messages.get(message) ?? fromUuidSafe(message);
  if (!message) return {};
  let item;
  try { item = resolveItem(message.getAssociatedItem?.()); } catch (_) { /* legacy/broken message */ }
  const flags = message.flags?.dnd5e;
  item ??= resolveItem(message.system?.item?.uuid ?? flags?.item?.uuid
    ?? flags?.use?.itemUuid ?? flags?.itemUuid);
  const speaker = message.speaker;
  // Scene token comes first: world Actors lose unlinked token identity.
  const tokenActor = game.scenes?.get(speaker?.scene)?.tokens?.get(speaker?.token)?.actor;
  const actor = item?.actor ?? tokenActor ?? game.actors.get(speaker?.actor);
  item ??= actor?.items?.get(message.system?.item?.id ?? flags?.item?.id ?? flags?.use?.itemId);
  return { item, attacker: item?.actor ?? actor };
}

export function resolveAttackContext(options = {}, target = null) {
  const origin = options.origin ?? options.dnd5e?.origin;
  const item = resolveItem(options.item) ?? resolveItem(options.dnd5e?.item)
    ?? resolveItem(origin) ?? resolveItem(options.from);
  let context = {
    item,
    attacker: item?.actor ?? resolveActor(options.sourceActor)
      ?? resolveActor(options.actor) ?? resolveActor(options.dnd5e?.actor) ?? resolveActor(origin)
  };
  const message = options.originatingMessage ?? options.message
    ?? options.messageId ?? options.dnd5e?.messageId ?? options.dnd5e?.context?.messageId
    ?? (origin?.documentName === "ChatMessage" ? origin : null);
  if (message) {
    const exact = messageContext(message);
    context.item ??= exact.item;
    context.attacker ??= exact.attacker;
  }
  // Never attach a different actor's weapon to an already identified attacker.
  // When an exact source was supplied, do not borrow unrelated recent chat.
  if (!message && !origin && !context.item) {
    for (const msg of Array.from(game.messages ?? []).slice(-16).reverse()) {
      if (!Number.isFinite(msg.timestamp) || Date.now() - msg.timestamp > 30000) continue;
      const candidate = messageContext(msg);
      if (!candidate.item || candidate.attacker?.uuid === target?.uuid) continue;
      if (context.attacker && candidate.attacker?.uuid !== context.attacker.uuid) continue;
      context = { item: candidate.item, attacker: context.attacker ?? candidate.attacker };
      break;
    }
  }
  context.attacker ??= fallbackAttacker(target);
  return { ...context, weaponName: context.item?.name ?? "your attack" };
}

export function hpValue(actor) {
  return Number(actor?.system?.attributes?.hp?.value ?? NaN);
}

export function changedHP(changed) {
  return changed?.["system.attributes.hp.value"] ?? changed?.system?.attributes?.hp?.value;
}

export function isFreshKill(oldHP, newHP) {
  return Number.isFinite(Number(oldHP)) && oldHP != null && Number(oldHP) > 0
    && Number.isFinite(Number(newHP)) && newHP != null && Number(newHP) <= 0;
}
