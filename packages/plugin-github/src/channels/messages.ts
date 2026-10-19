/**
 * Message IDs must sort chronologically as strings, because the container keeps
 * `id > lastSeen`. GitHub's comment IDs grow over time, so they're zero-padded
 * to 20 digits, enough for any 64-bit ID. The opening post is all zeros, so it
 * sorts before every comment.
 */
export const messageId = (commentId: number | null) => String(commentId ?? 0).padStart(20, "0");
export const OPENING_POST_ID = messageId(null);
