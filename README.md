# A Moment of Glory (Foundry v13)

When a character reduces a hostile creature to **0 HP**, the GM is asked whether to grant a **Moment of Glory** — a short roleplaying beat so the player can describe the finishing blow.

## Requirements

- Foundry VTT **v13**
- [D&D 5e](https://github.com/foundryvtt/dnd5e) **3.0+**
- Recommended: [Midi-QOL](https://gitlab.com/tposney/midi-qol) (primary damage detection)

## Install

1. Copy the `moment-of-glory` folder to `{FoundryData}/modules/moment-of-glory`
2. Enable **A Moment of Glory** in your world
3. Enable **Midi-QOL** for best results

## Flow

1. Hostile creature is reduced to 0 HP (Midi-QOL damage workflow)
2. **GM** sees: Offer Moment of Glory / Decline
3. **Decline** → nothing extra; death proceeds as normal
4. **Offer** → the killing player gets a prompt to describe the finish
5. Description (if any) is posted to chat

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Moment of Glory | On | Master toggle |
| Hostile targets only | On | Only hostile disposition |
| Ignore player characters | On | Never trigger on PC deaths |

## Development notes

- GM client orchestrates prompts; player dialogs use `game.socket`
- Duplicate prompts for the same target are suppressed for a few seconds
- Without Midi-QOL, a lighter `dnd5e.applyDamage` fallback is used

## License

MIT
