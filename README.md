# Kaizen HQ

Private, real-time team chat for **Kaizen Real Estate Team**. It gives the team one place for listings, leads, wins and marketing, outside of WhatsApp threads and email chains.

## What it does

- **Channels:** `#general`, `#wins`, `#listings`, `#leads` and `#marketing` come built in. Anyone can create, browse, join or leave channels and edit a channel's topic.
- **Direct messages:** one-on-one chats, plus "notes to self."
- **Threads:** reply to a message without cluttering the channel.
- **@mentions:** autocomplete for teammates' names, plus `@here` and `@channel`. Mentions are highlighted and counted as unread.
- **Reactions, pins, edits and deletes:** press ↑ in an empty message box to edit your last message.
- **Search:** Ctrl/⌘+K searches every message you have access to.
- **Live updates:** messages, typing indicators, online status, unread badges and desktop notifications.
- **Formatting:** `**bold**`, `_italic_`, `~strike~`, `` `code` ``, ```` ```code blocks``` ````, `> quotes`, and links become clickable.
- **Profiles:** each person has a name, role and status (e.g. "🏡 At a listing appointment").
- **Admin:** the first person to sign up becomes the admin and can delete any message.
- **Mobile:** works in a phone browser. Add it to your home screen to use it like an app.

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000 and create the first account (that account becomes the admin).

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `INVITE_CODE` | *(none)* | If set, new sign-ups must enter this code. **Set this before going live.** |
| `WORKSPACE_NAME` | `Kaizen HQ` | Name shown in the app |
| `DATA_DIR` | `./data` | Where messages and accounts are saved (`db.json`) |

## Put it online

The app is a single Node server. Any host that runs Node and has **persistent disk** will work, for example Render, Railway or Fly.io.

1. Connect this GitHub repo to the host.
2. Build command `npm install`, start command `npm start`.
3. Attach a persistent disk and set `DATA_DIR` to its mount path (e.g. `/data`).
4. Set `INVITE_CODE` and share it with the team.
5. Optional: point a subdomain like `hq.kaizenrealestate.ca` at it.

> Without a persistent disk, messages are wiped every time the host restarts.

## Files

- `server.js`: the API, real-time messaging (Socket.IO) and storage
- `public/`: the web app (`index.html`, `styles.css`, `app.js`)
