// Profile pictures: an image link a person sets on their profile, stored in users.preferences.avatarUrl (JSON, no
// column of its own). Person references (people, messages, tickets) carry it as avatarUrl; the app shows initials
// when it's missing or the picture fails to load.

/** Same rule as moduleSettings.imageUrlSchema: http(s), no spaces, quotes, brackets, or backslashes. */
const SAFE_IMAGE_URL = /^https?:\/\/[^\s"'()<>\\]+$/i;

/** The avatar link in a users.preferences value (JSON text or an already-parsed object), or null. */
export function avatarUrlOf(preferences) {
  let value = preferences;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      return null;
    }
  }
  const url = value && typeof value === "object" ? value.avatarUrl : null;
  return typeof url === "string" && url.length <= 1000 && SAFE_IMAGE_URL.test(url) ? url : null;
}
