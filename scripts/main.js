import { MODULE_ID, registerSettings, isEnabled } from "./settings.js";
import { considerWorkflow, handleSocket } from "./moment-of-glory.js";
import { registerFallbackDamageHooks } from "./fallback-damage.js";

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

  const hasMidi = Boolean(game.modules.get("midi-qol")?.active);
  if (hasMidi) {
    registerMidiHooks();
    console.log(`${MODULE_ID} | Using Midi-QOL damage detection`);
  } else {
    registerFallbackDamageHooks();
    console.log(`${MODULE_ID} | Midi-QOL not active — using built-in dnd5e damage detection`);
    if (game.user?.isGM) {
      ui.notifications?.info("A Moment of Glory: running without Midi-QOL (built-in damage detection).");
    }
  }

  console.log(`${MODULE_ID} | Ready`);
});

/**
 * Preferred path when Midi-QOL is installed.
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
      if (!game.user?.isGM) return;
      considerWorkflow(workflow).catch((err) => {
        console.error(`${MODULE_ID} | considerWorkflow failed (${hookName})`, err);
      });
    });
  }
}
