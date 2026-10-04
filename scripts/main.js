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

  // Always register the dnd5e fallback. When Midi is active it still helps if a
  // Midi hook misses a kill; isDuplicate() prevents double prompts.
  registerFallbackDamageHooks();

  if (hasMidi) {
    registerMidiHooks();
    console.log(`${MODULE_ID} | Using Midi-QOL hooks + dnd5e fallback`);
  } else {
    console.log(`${MODULE_ID} | Midi-QOL not active — using built-in dnd5e damage detection`);
  }

  console.log(`${MODULE_ID} | Ready`);
});

/**
 * Preferred path when Midi-QOL is installed.
 */
function registerMidiHooks() {
  const workflowHooks = [
    "midi-qol.RollComplete",
    "midi-qol.postCompleted",
    "midi-qol.postApplyDynamicEffects"
  ];

  for (const hookName of workflowHooks) {
    Hooks.on(hookName, (workflow) => {
      if (!isEnabled() || !game.user?.isGM) return;
      considerWorkflow(workflow).catch((err) => {
        console.error(`${MODULE_ID} | considerWorkflow failed (${hookName})`, err);
      });
    });
  }

  // Most reliable: fires once per target after HP damage is applied.
  Hooks.on("midi-qol.damaged", (tokenOrActor, options = {}) => {
    if (!isEnabled() || !game.user?.isGM) return;

    const damageItem = options.damageItem || options;
    const workflow = options.workflow;
    const item = options.item || workflow?.item;
    const newHP = damageItem?.newHP;
    if (newHP !== undefined && Number(newHP) > 0) return;

    const targetRef = tokenOrActor?.actor || tokenOrActor;
    const detail = {
      target: targetRef,
      attacker: item?.actor || workflow?.actor,
      item,
      weaponName: item?.name,
      oldHP: damageItem?.oldHP,
      newHP: damageItem?.newHP,
      totalDamage: damageItem?.hpDamage ?? damageItem?.totalDamage,
      damageList: damageItem ? [damageItem] : undefined
    };

    considerWorkflow(workflow || {
      actor: detail.attacker,
      item,
      damageList: detail.damageList
    }, detail).catch((err) => {
      console.error(`${MODULE_ID} | considerWorkflow failed (midi-qol.damaged)`, err);
    });
  });
}
