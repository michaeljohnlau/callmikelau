# Kaizen HQ

Private, real-time team chat for **Kaizen Real Estate Team**. It gives the team one place for listings, leads, wins and marketing, outside of WhatsApp threads and email chains.

## What it does

- **Channels:** `#general`, `#wins`, `#listings`, `#leads` and `#marketing` come built in. Anyone can create, browse, join or leave channels and edit a channel's topic.
- **Sub-channels:** one per listing address, e.g. `#listings › 24 Juniper Crescent`. Everyone in the main channel is added automatically. Archive a sub-channel when the deal closes; its messages stay searchable.
- **☀️ Today (home screen):** each person sees only their own work: tasks waiting for them to accept, tasks passed back to them, overdue, due today, blockers and decisions needed, unread @mentions, lead steps they claimed, and what's coming up this week.
- **Tasks from messages:** hover a message and tap ☑ to turn it into a task with an owner and due date. The task links back to the conversation, the message shows the task's status, and a note is left in the thread.
- **Handoffs:** giving a task to someone else (or Grok doing it) puts it in their Today to **Accept** or **Pass it back** with a reason. Until then the sender sees "waiting on …". Handoffs nobody has accepted for 24h show up as Urgent.
- **Listing stages:** listing sub-channels have a stage bar: **Listing → Offer accepted → Firm sale → Closing**. Moving to a stage adds that stage's tasks with due dates. In a template, `| 2d` at the end of a line means "due 2 days after the stage starts". Admins can edit the templates.
- **Links to the original records:** each channel can link its Follow Up Boss contact, Drive folder and listing page. The contact card shows live details from Follow Up Boss, so client details are never copied into Kaizen HQ.
- **Daily summary & quiet hours:** each person gets one morning message from *Kaizen HQ* (default 7:30am) with what's overdue, due today, waiting for them, decisions needed and what the team finished yesterday. Quiet hours (default 9pm–7am) hold back phone notifications. Both are set under 🔔 Settings → Notifications.
- **📊 Team view (admins):** a weekly view for the team lead. It shows each person's open, overdue, to-accept and finished tasks (tap someone to see their list); handoffs nobody has accepted, with **👋 Nudge** (push + DM) and **Reassign**; decisions needed; and every listing's stage, progress, overdue count and next task. Private channels you're not in stay private.
- **Team dashboard:** a bar across the top (collapsible) shows:
  - **📈 Forecast:** the team's closed + pending GCI and deals for the year vs. the combined goal. Tap it for each agent's numbers.
  - **🎯 Your goal:** each agent sets and edits their own goal, closed and pending numbers. Admins can edit anyone's.
  - **⚠️ Urgent:** lead steps nobody has claimed, steps claimed over 24h ago and still open, and items anyone can add (e.g. "Offer deadline 5pm").
  - **🔥 Hot leads:** a scrolling ticker. Each name opens the lead in Follow Up Boss. It pulls leads whose Follow Up Boss stage or tag says "Hot" (refreshed every 5 minutes), plus any lead a teammate marks 🔥 in the app.
- **Checklists:** a panel on the right (about 30% of the screen) for any channel. On phones, tap **☑ 3/30** in the channel header to open it.
  - New sub-channels under `#listings` get the **New listing** checklist automatically. Add **Open house** tasks, or type your own.
  - Each tick shows who did it and when. Admins edit the templates under **Settings → Workspace**.
- **Branding & photos:** admins upload the workspace logo. Everyone can add a profile photo: a cropper lets you drag to position it and zoom (slider, pinch or mouse wheel) before saving. Photos are about 3–10 KB each.
- **Deleting channels:** the creator or an admin can permanently delete a channel or sub-channel under 👥 → **🗑 Delete** (type DELETE to confirm). This erases its messages and tasks for everyone; **Archive** is the reversible option. Both are one tap away from the **⋯** next to each sub-channel in the sidebar. Archived sub-channels collect under a **🗄 N archived** row beneath their main channel; open one to **Unarchive** it. Built-in channels, the Follow Up Boss lead channel, and main channels that still have sub-channels can't be deleted.
- **Sign-up code:** admins set it under **Settings → Workspace** (not case-sensitive). It overrides the `INVITE_CODE` environment variable.
- **Private channels:** when creating a channel or sub-channel, choose **🔒 Only people I choose**. A private channel is hidden from everyone else: it doesn't appear in their sidebar, Browse, search, the dashboard, or to AI assistants. Its creator or an admin can add or remove people, or make it open, under 👥 in the channel header. Admins can still find private channels in Browse.
- **App-icon badge:** each push notification carries your unread count. DMs and channels set to *All messages* count every message; *Mentions only* channels count mentions. The number shows on the app icon on iPhone (Home Screen app, iOS 16.4+) and desktop, and on Android where the launcher supports it.
- **Notification controls:** set each channel to *All messages*, *Mentions only* or *Muted* (sub-channels follow their main channel unless changed). Choose from 6 sounds and pause notifications for 30 min, 1 hour, 2 hours or until tomorrow at 8am. Find these under the 🔔 in the sidebar or the channel header.
- **AI assistants (MCP):** connect Grok or any MCP-capable assistant. See below.
- **Direct messages:** one-on-one chats, plus "notes to self."
- **Threads:** reply to a message without cluttering the channel.
- **@mentions:** autocomplete for teammates' names, plus `@here` and `@channel`. Mentions are highlighted and counted as unread.
- **Reactions, pins, edits and deletes:** press ↑ in an empty message box to edit your last message.
- **Search:** Ctrl/⌘+K searches every message you have access to.
- **Live updates:** messages, typing indicators, online status, unread badges and desktop notifications.
- **Formatting:** `**bold**`, `_italic_`, `~strike~`, `` `code` ``, ```` ```code blocks``` ````, `> quotes`, and links become clickable.
- **Profiles:** each person has a name, role and status (e.g. "🏡 At a listing appointment").
- **Admin:** the first person to sign up becomes the admin and can delete any message.
- **Mobile app:** installs on iPhone and Android with push notifications. See below.

## Mobile app (iPhone + Android)

Kaizen HQ installs on phones like a regular app. It gets a home-screen icon, opens full-screen, and sends push notifications. No App Store is needed.

**iPhone (iOS 16.4+):** open the site in **Safari** → tap **Share** → **Add to Home Screen** → open Kaizen HQ from the home screen → tap **Turn on notifications**.

**Android:** open the site in **Chrome** → tap **Install** on the banner (or ⋮ menu → **Install app**) → tap **Turn on notifications**.

Push notifications go out for **direct messages, @mentions, @here/@channel and thread replies**, only when the app isn't open on screen. This keeps people from getting buzzed twice.

> Push needs the site on **HTTPS**, which every host listed below provides. The push keys are saved in `DATA_DIR/vapid.json`. Keep that folder on a persistent disk, or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, so phones stay subscribed between restarts.

## Follow Up Boss: new leads post to #leads

1. In Follow Up Boss, signed in as the **account owner**, go to **Admin → API → Create API Key**.
2. In Kaizen HQ, signed in as an admin and **from your live https address**, go to **🔔 Settings → Integrations → Follow Up Boss**. Paste the key, pick the channel (default `#leads`) and press **Connect**.
3. Press **Post a test lead** to see your most recent contact posted.

Kaizen HQ registers a `peopleCreated` webhook with Follow Up Boss. About 5 seconds after a lead is created (so its inquiry details are complete), it is posted with name, phone, email, source, stage, price, address, tags and a link back to Follow Up Boss. The assigned agent is @mentioned, so they get a push notification. Retries never post a lead twice.

**First steps (lead playbooks).** Each lead is sorted as a **seller**, **buyer** or **other** lead, using the inquiry type, tags, source and stage. It is then posted with a checklist:

| Lead | Default first steps | Pinned until done |
|---|---|---|
| 🏡 Seller | Call {first} within 5 minutes · Prepare CMA for {address} · Book the listing appointment | Yes |
| 🔑 Buyer | Call {first} within 5 minutes · Send matching listings | No |
| 🆕 Other | Call {first} within 5 minutes | No |

Teammates tap **I'll take it** to claim a step, then tick it off when it's done. Each claim and completion is noted in the lead's thread. When every step is done, a pinned lead unpins itself. You can edit the steps and pin settings under **Settings → Integrations → First steps for new leads**.

If Follow Up Boss responds that a system key is required, register free at apps.followupboss.com/system-registration (system name `KaizenHQ`). Then paste the key under **Advanced: system key** and press Connect again.

## API (Zapier, Make, website forms)

Keys from **Settings → AI & API** also work as REST API keys:

```bash
curl -X POST https://<your-domain>/api/v1/messages \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"channel": "leads", "text": "New valuation request: 8 Elm Ave"}'
```

Add `"tasks": ["Prepare CMA for 8 Elm Ave"], "pin": true` to post with a first-steps checklist.

`GET /api/v1/channels` lists the channels. A `channel` can be a name like `leads`, a sub-channel like `listings/24-juniper-crescent`, or an id.

## Connect Grok (or another AI assistant) over MCP

Kaizen HQ includes an MCP server at `https://<your-domain>/mcp` (Streamable HTTP).

1. Sign in as an admin, then go to **🔔 Settings → AI assistants → Create key**. Copy the key; it is only shown once.
2. Connect it:
   - **Grok chat (grok.com → Connectors → New Connector → Custom):** paste the single link shown after creating the key, `https://<your-domain>/mcp/<key>`.
   - **Grok Bot, xAI API, Claude or other MCP apps that support headers:** URL `https://<your-domain>/mcp` with header `Authorization: Bearer <key>`.
3. Create **one key per bot** (e.g. "Grok CMA", "Grok Marketing"). Each bot posts under its own name, shows when it was last used, and can be removed on its own.
4. The assistant appears in the team list with an **AI** tag. Remove it any time from the same screen and its key stops working immediately.

**Access levels** (chosen when you create the key, changeable any time in **Settings → AI & API**):
- **Full access** (default): the assistant can do what a team admin can do in the app. That covers chatting in channels and direct messages, creating listing sub-channels (with checklists, privacy and members), moving listing stages, adding Follow Up Boss / Drive / listing links, and creating, assigning, editing and deleting tasks (handoffs still need the person to accept). It can also react, pin, and edit or delete messages, mark hot leads, add urgent items, archive or delete channels, manage members and privacy, update goals, read the Team view and nudge task owners.
- **Standard**: the same, except archiving/deleting channels, privacy and member removal, goals and the Team view.

Assistants act through exactly the same actions as people, with the same rules. No assistant can change bot keys, the sign-up code, the Follow Up Boss connection or checklist templates. Assistants also can't see private channels or DMs they aren't part of; add an assistant to a private channel like a teammate to give it access.

**Tools (45):** messages (`send_message`, `edit_message`, `delete_message`, `react_to_message`, `pin_message`, `read_messages`, `read_thread`, `search_messages`, `get_my_mentions`), direct messages (`send_direct_message`, `read_direct_messages`, `list_direct_messages`), channels (`list_channels`, `get_channel_info`, `create_channel`, `set_channel_topic`, `join_channel`, `leave_channel`, `add_people_to_channel`, `remove_person_from_channel`, `set_channel_privacy`, `archive_channel`, `delete_channel`), listings (`set_listing_stage`, `set_channel_links`), checklists & tasks (`get_checklist`, `update_checklist`, `list_checklist_templates`, `add_checklist_from_template`, `remove_checklist`, `create_task`, `edit_task`, `delete_task`, `list_tasks`, `nudge_task_owner`, `list_open_tasks`, `update_task`), leads & dashboard (`mark_hot_lead`, `add_urgent_item`, `resolve_urgent_item`, `update_goal`, `get_dashboard`, `get_team_view`, `get_person_today`), and `list_team`.

**Example (xAI API):** pass the MCP server as a tool when calling Grok:

```json
{
  "tools": [{
    "type": "mcp",
    "server_label": "kaizen-hq",
    "server_url": "https://hq.kaizenrealestate.ca/mcp",
    "authorization": "<key>"
  }]
}
```

(The exact field names depend on the Grok or xAI client you use. The URL and Bearer key are the only two things it needs.)

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
| `DATA_DIR` | `./data` | Where messages, accounts and push keys are saved |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(auto-generated)* | Optional fixed keys for push notifications |
| `VAPID_SUBJECT` | `mailto:info@kaizenrealestate.ca` | Contact address sent to Apple/Google push services |

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
- `public/sw.js`, `public/manifest.webmanifest` and `public/icons/`: the installable mobile app (offline shell and push notifications)
