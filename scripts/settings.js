export const MODULE_ID = "moment-of-glory";

export function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "MOMENT_OF_GLORY.Settings.Enabled.Name",
    hint: "MOMENT_OF_GLORY.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "hostilesOnly", {
    name: "MOMENT_OF_GLORY.Settings.HostilesOnly.Name",
    hint: "MOMENT_OF_GLORY.Settings.HostilesOnly.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "ignorePCs", {
    name: "MOMENT_OF_GLORY.Settings.IgnorePCs.Name",
    hint: "MOMENT_OF_GLORY.Settings.IgnorePCs.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}

export function isEnabled() {
  return game.settings.get(MODULE_ID, "enabled") !== false;
}

export function hostilesOnly() {
  return game.settings.get(MODULE_ID, "hostilesOnly") !== false;
}

export function ignorePCs() {
  return game.settings.get(MODULE_ID, "ignorePCs") !== false;
}
