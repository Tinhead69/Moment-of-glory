import { MODULE_ID, registerSettings, isEnabled } from "./settings.js";
import { considerWorkflow, handleSocket } from "./moment-of-glory.js";

Hooks.once("init", () => {
  registerSettings();
  console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", () => {
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    handleSocket(data).catch((err) => {
      console.error(`${MODULE_ID} | Socket handler failed`, err);
    });
  });

  registerMidiHooks();
  registerFallbackDamageHooks();

  if (!game.modules.get("midi-qol")?.active) {
    console.warn(`${MODULE_ID} | midi-qol not active — using dnd5e damage fallbacks`);
    if (game.user?.isGM) {
      ui.notifications?.warn(game.i18n.localize("MOMENT_OF_GLORY.Notify.NoMidi"));
    }
  }

  console.log(`${MODULE_ID} | Ready`);
});

/**
 * Preferred path: Midi-QOL damage workflows.
 * Hook names vary slightly by Midi version — register several safely.
 */
function registerMidiHooks() {
  const midiHooks = [
    "midi-qol.RollComplete",
    "midi-qol.DamageRollComplete",
    "midi-qol.postApplyDynamicEffects"
  ];

  for (const hookName of midiHooks) {
    Hooks.on(hookName, (workflow) => {
      if (!isEnabled()) return;
      // Only the GM orchestrates prompts.
      if (!game.user?.isGM) return;
      considerWorkflow(workflow).catch((err) => {
        console.error(`${MODULE_ID} | considerWorkflow failed (${hookName})`, err);
      });
    });
  }
}

/**
 * Fallback when Midi is missing: watch dnd5e damage application.
 * Less precise than Midi damageList, but covers basic attacks.
 */
function registerFallbackDamageHooks() {
  // dnd5e v3+/v4+ style
  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
    if (!isEnabled() || !game.user?.isGM) return;
    if (game.modules.get("midi-qol")?.active) return; // Midi path preferred

    const target = actor?.documentName === "Actor" ? actor : actor?.actor;
    if (!target) return;

    const hp = Number(target.system?.attributes?.hp?.value ?? 1);
    if (hp > 0) return;

    const attacker = options?.midi?.sourceActor
      || options?.sourceActor
      || canvas.tokens?.controlled?.[0]?.actor
      || null;

    considerWorkflow(
      { actor: attacker, targets: [target], damageList: [] },
      { target, newHP: hp, totalDamage: amount }
    ).catch((err) => {
      console.error(`${MODULE_ID} | fallback applyDamage failed`, err);
    });
  });
}
