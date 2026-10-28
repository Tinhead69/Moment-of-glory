# A Moment of Glory (Foundry v13 and v14)

When a character reduces a hostile creature to **0 HP**, the GM is asked whether to grant a **Moment of Glory** — a short roleplaying beat so the player can describe the finishing blow.

## Requirements

- Foundry VTT **v13 or v14**
- [D&D 5e](https://github.com/foundryvtt/dnd5e) **3.0.0 or newer**, using a system release that supports your Foundry version
- Works **without Midi-QOL** via native damage hooks and core HP tracking
- Optional: a [Midi-QOL](https://gitlab.com/tposney/midi-qol) release compatible with your Foundry/system combination

Version 0.2.0 handles legacy chat flags, activity-based item references, and newer
chat data including D&D 5e 6.0.6. The minimum D&D system version is 3.0.0.
This does not make an old system compatible with a newer Foundry core: the
system itself must support the selected core. D&D 5e 6.0.6 requires Foundry
14.367+. Future system releases and every historical release are not guaranteed.

Automated checks use mocked Foundry APIs. Live v13/v14 world verification is
still needed; the manifest retains its previous verified-core value for that
reason. See [COMPATIBILITY.md](COMPATIBILITY.md) for coverage and references.

## Install

1. Copy the `moment-of-glory` folder to `{FoundryData}/modules/moment-of-glory`
2. Enable **A Moment of Glory** in your world
3. Reload connected clients after upgrading the module

## Flow

1. Hostile creature drops from positive HP to 0 HP
2. **GM** sees: Offer Moment of Glory / Decline
3. **Decline** → nothing extra; death proceeds as normal
4. **Offer** → the killing player gets a spotlight prompt naming the **weapon/item** used
5. They describe the kill **at the table** (no typing); chat notes that they seized the moment
6. The defeated creature’s token is marked with a **skull** (dead status / overlay)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Moment of Glory | On | Master toggle |
| Hostile targets only | On | Only hostile disposition |
| Ignore player characters | On | Never trigger on PC deaths |

## Development notes

- One active GM orchestrates prompts; player dialogs use `game.socket`
- Duplicate prompts are suppressed throughout an active dialog and briefly after completion
- Native damage hooks provide attack context; cached core HP updates cover manual edits and older system paths
- Unknown previous HP and repeated 0 HP updates do not trigger a kill
- When exact item context is unavailable, attribution is best effort (recent chat within 30 seconds, current combatant, or selected character)

Run regression checks with Node.js 20+: `node --test tests/compatibility.test.js`
(or `npm test` when npm is installed). No dependencies are required.

## License

MIT
