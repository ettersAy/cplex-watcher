import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  + "\nexport {confirmationLifetimeMs, issueConfirmation, readConfirmation};";
const { confirmationLifetimeMs, issueConfirmation, readConfirmation } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const chat = { id: 123, type: "private" };
const botId = 456, now = 1_800_000_000_000, secret = "synthetic-key";
const proposal = { operation: "test_confirmation", target: "film-id", scope: "expected_revision", prompt: "The app will do the test action." };
const { text, replyMarkup } = await issueConfirmation(secret, chat, proposal, now);
assert.deepEqual(replyMarkup, { force_reply: true });
const reply = { from: { id: botId, is_bot: true }, chat, message_id: 1, text };
const yes = { from: { id: chat.id, is_bot: false }, chat, text: "Yes", reply_to_message: reply };
const check = (message, time = now) => readConfirmation(secret, botId, message, time);
const accepted = await check(yes);
assert.equal(accepted.operation, proposal.operation);
assert.equal(accepted.target, proposal.target);
assert.equal(accepted.scope, proposal.scope);
assert.match(accepted.nonce, /^[A-Za-z0-9_-]{22}$/);
assert.equal(accepted.expiresAt, now + confirmationLifetimeMs);
assert.equal((await check(yes)).nonce, accepted.nonce, "Replay carries same durable receipt key");
assert.notEqual((await check({ ...yes, reply_to_message: { ...reply, text: (await issueConfirmation(secret, chat, proposal, now)).text } })).nonce, accepted.nonce);
assert.equal(await check(yes, now + confirmationLifetimeMs), null);
assert.equal(await check({ ...yes, text: "Yes, please" }), null);
assert.equal((await check({ ...yes, text: "No" })).cancel, true);
assert.equal(await check({ ...yes, reply_to_message: undefined }), null);
assert.equal(await check({ ...yes, chat: { id: 123, type: "group" } }), null);
assert.equal(await check({ ...yes, from: { id: 789, is_bot: false } }), null);
assert.equal(await check({ ...yes, from: { id: 789, is_bot: false }, chat: { ...chat, id: 789 },
  reply_to_message: { ...reply, chat: { ...chat, id: 789 } } }), null);
assert.equal(await check({ ...yes, reply_to_message: { ...reply, from: { id: 777, is_bot: true } } }), null);
assert.equal(await check({ ...yes, reply_to_message: { ...reply, text: reply.text.replace("test action", "another action") } }), null);
assert.equal(await readConfirmation("different-secret", botId, yes, now), null);
await assert.rejects(() => issueConfirmation(secret, { ...chat, type: "group" }, proposal, now));
console.log("Confirmation draft checks passed: signed consequence, account, bot reply, one nonce and expiry");

const ownerText = execFileSync("python3", ["-c",
  "from ticket_membership import owner_offer; print(owner_offer('123', 'other-film', 'Friend stopped watching Café.', 'synthetic-key', 1800000000000))"
], { encoding: "utf8" }).trimEnd();
const offerReply = { ...reply, text: ownerText };
const stopToo = await check({ ...yes, text: "Stop too", reply_to_message: offerReply });
assert.equal(stopToo.operation, "unfollow_owner_offer");
assert.equal(stopToo.target, "other-film");
assert.equal(stopToo.keep, false);
const keep = await check({ ...yes, text: "Keep watching", reply_to_message: offerReply });
assert.equal(keep.keep, true);
assert.equal(keep.nonce, stopToo.nonce, "Keep and Stop too spend the same approval");
assert.equal(await check({ ...yes, text: "Stop too" }), null, "A personal prompt only accepts Yes");
