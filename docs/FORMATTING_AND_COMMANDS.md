<p align="center">
  <b>English</b> • <a href="FORMATTING_AND_COMMANDS.fr.md">Français</a>
</p>

# Formatting, commands, quick texts and search

This page describes the conversation tools of OpenWLM. The same information is available in
the app: **main menu → Help**, the **Help** link on the sign-in screen, or the `/help` command.

- [Formatting](#formatting)
- [Commands](#commands)
- [Quick texts](#quick-texts)
- [Recalling your messages](#recalling-your-messages)
- [Searching a conversation](#searching-a-conversation)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Technical notes](#technical-notes)

---

## Formatting

Your **nickname**, **personal message** and **messages** can use colors, gradients and styles.
Type the tags yourself, or use the **🎨** button: next to the conversation input, and next to the
nickname and personal message fields in Options → Personal (with a preview).
With a selection, 🎨 wraps it in the tags; without one, it inserts the tags and places the cursor
between them.

| You type | Result |
|---|---|
| `[b]bold[/b]` | **bold** |
| `[i]italic[/i]` | *italic* |
| `[u]underlined[/u]` | underlined |
| `[s]struck[/s]` | ~~struck~~ |
| `[c=4]red[/c]` | red text (color no. 4) |
| `[c=#1E90FF]blue[/c]` | any color as `#RRGGBB` |
| `[a=8]yellow background[/a]` | background color |
| `[c=4]gradient[/c=12]` | text gradient from color 4 to color 12 (the end color goes on the closing tag) |
| `[a=4]background[/a=12]` | background gradient |
| `[c=3][b]Bold green[/b][/c]` | tags can be combined |

**Colors**: a number from the palette below, or any `#RRGGBB` color.

| No. | Color | No. | Color | No. | Color | No. | Color |
|---|---|---|---|---|---|---|---|
| 0 | `#FFFFFF` white | 4 | `#FF0000` red | 8 | `#FFFF00` yellow | 12 | `#0000FC` blue |
| 1 | `#000000` black | 5 | `#7F0000` maroon | 9 | `#00FC00` lime | 13 | `#FF00FF` magenta |
| 2 | `#00007F` navy | 6 | `#9C009C` purple | 10 | `#009393` teal | 14 | `#7F7F7F` grey |
| 3 | `#009300` green | 7 | `#FC7F00` orange | 11 | `#00FFFF` cyan | 15 | `#D2D2D2` light grey |

**Short codes** with the middle dot `·` (Alt+0183 on Windows, Option+Shift+9 on a US Mac keyboard): `·$4` color 4, `·#FF0000` any color, `·b` `·i` `·u` `·s` toggle a style, `·0` resets
everything. Example: `·$12blue·0 normal`.

**Rules**

- Nicknames are limited to **50 visible characters** and personal messages to **150**: tags do
  not count. The raw text (tags included) is limited to 300 and 600 characters.
- Invalid or unknown tags (`[c=99]`, `[x]`…) are shown as typed.
- Emoticons still work inside formatted text.
- Where formatting cannot be shown (system notifications, window titles, tooltips), the tags are
  removed and the plain text is displayed.
- **Plain text**: untick *Show formatting of nicknames, personal messages and messages* in
  Options → Messages. Everything is then displayed without colors or styles (and without tags).

## Commands

Type a command in a conversation and press **Enter**. A list of matching commands appears as soon
as you type `/`; **Tab** completes the first one.

| Command | Effect |
|---|---|
| `/me <text>` | Action: your contact sees `* YourName text` |
| `/clear` | Clears the display of this conversation (the history is not deleted) |
| `/online` | Status Available |
| `/busy` | Status Busy |
| `/away` | Status Away |
| `/offline` | Appear offline |
| `/nick <text>` | Changes your nickname (formatting allowed) |
| `/psm <text>` | Changes your personal message (formatting allowed) |
| `/all <text>` | Sends the message to every open conversation (the test contact excluded) |
| `/signout` | Signs out (everywhere, like the menu) |
| `/help` | Opens the help window |

- To send a message that really starts with `/`, type `//`: a single `/` is sent
  (`//path` → `/path`).
- An unknown command is not sent: a window says so.
- In the conversation with the **OpenWLM test contact**, its own commands (`/help`, `/wizz`,
  `/p4`, `/morpion`…) keep going to the test contact.

## Quick texts

Ready-made messages sent with `/shortcut`. Create them in **Options → Messages → Quick texts**.

- Shortcut: 1 to 20 characters among `a-z`, `0-9`, `-` and `_`; it cannot be a command name.
- `(!N)` in the text is replaced by the contact's name (without formatting).
- Text typed after the shortcut is appended: `/hi see you later` sends the quick text followed by
  `see you later`.
- Quick texts appear in the command list, after the commands.
- Up to 30 quick texts of 1,000 characters each. They are saved **on the device** (`wlm_prefs`),
  never on the server.

Example: shortcut `hi`, text `Hi (!N), how are you?` → typing `/hi` in a conversation with Alice
sends `Hi Alice, how are you?`.

## Recalling your messages

**Ctrl+↑** puts your previous messages (and commands) back into the input field, one by one;
**Ctrl+↓** goes the other way and, past the most recent one, restores what you were typing.
The last 50 entries are kept for the session, in memory only (nothing is stored).

## Searching a conversation

**Ctrl+F** (Cmd+F on macOS) in a conversation opens a search bar instead of the browser's search
(keyboard only: not available on phones).
Matches are highlighted in the messages, with a counter (`2/5`), starting with the most recent one.
**Enter** goes to the previous (older) match and **Shift+Enter** back to the more recent one, as do
the ▲ / ▼ buttons; **Esc** closes the search. Only the displayed messages are
searched (after `/clear`, nothing is left to search).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter | Send the message |
| Shift+Enter | New line |
| Ctrl+↑ / Ctrl+↓ | Recall your previous messages |
| Tab | Complete a command |
| Ctrl+F | Search the conversation |
| Esc | Close the window or the search |

## Technical notes

- **Rendering** (`src/utils/plusFormat.tsx`): the text is split into segments rendered by React —
  no HTML is ever injected. Only validated colors (palette or `#RRGGBB`) reach the styles.
  Gradients use a CSS `linear-gradient` with `background-clip: text`.
- **Messages**: formatting is part of the message text, so it is end-to-end encrypted like the rest.
  A `/me` action adds an `action: true` field to the signed envelope
  (`src/utils/MessageEnvelope.ts`).
- **Server** (`server/utils/plusText.js`): same grammar, used only to strip tags — to check the
  visible length of nicknames and personal messages (`server/routes/users.js`,
  `server/routes/auth.js`) and to build push notification titles.
- **Commands**: parsing in `src/utils/chatCommands.ts`, execution in `src/utils/runChatCommand.ts`
  (the app state it needs is passed in a context), suggestion list in
  `src/components/CommandHelper.tsx`, recall in `src/hooks/useSentHistory.ts`, Ctrl+F in
  `src/hooks/useConversationSearchShortcut.ts`.
- **Search** (`src/components/ConversationSearch.tsx`): CSS Custom Highlight API
  (`::highlight(wlm-search)`), no change to the messages' DOM.
- **Tests**: `e2e/extras.spec.ts` (end-to-end scenario across two accounts),
  `tests/test_profile_limits.js` (server limits).
