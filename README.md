# Poly the Parrot

Local Discord bot for hackathon team check-ins.

## Features

- `/poly checkin` sends a numbered check-in to all `team-*` channels and mentions each team role.
- `/poly send` sends your message to one team channel or all team channels.
- `/poly status` reads full history from all team channels (plus control channel) and asks OpenAI for a human-readable organizer summary.
- Standby mode: when `@Poly` is mentioned in a `team-*` channel, it responds from context or escalates to the organizer.
- Prompting and bot voice are fully editable in `prompts/config.json` without code changes.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill values.

3. Fill in `knowledge/hackathon-info.md`.
4. Edit prompts/personality in `prompts/config.json`.
5. Set model + reasoning in `config/openai.json` (defaults are `gpt-5.1` and `low`).

6. Start in dev:

```bash
npm run dev
```

The bot syncs slash commands to your configured guild on startup.

## Command Usage

- `/poly checkin`
- `/poly status`
- `/poly send message:"text" target:all`
- `/poly send message:"text" target:team-7`

## Notes

- Control commands are restricted to `OWNER_USER_ID` in `POLY_CONTROL_CHANNEL_ID`.
- Team channels are discovered by name pattern `team-1`, `team-2`, etc.
- If `knowledge/hackathon-info.md` is still placeholder text, status and standby will ask you to complete it first.
