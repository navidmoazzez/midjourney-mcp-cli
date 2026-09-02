import { describe, expect, it } from "vitest";

import { describeBody, errorFor, looksLikeChallenge, looksSignedOut } from "../src/api/errors.js";

const CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body></body></html>`;

describe("looksLikeChallenge", () => {
  it("recognises the Cloudflare interstitial", () => {
    expect(looksLikeChallenge(CHALLENGE)).toBe(true);
    expect(looksLikeChallenge('<html><body><div id="cf-browser-verification"></div></body></html>')).toBe(true);
  });

  it("does not mistake a real answer for one", () => {
    expect(looksLikeChallenge('{"jobs":[]}')).toBe(false);
  });
});

describe("looksSignedOut", () => {
  it("treats a 401 as signed out whatever the body says", () => {
    expect(looksSignedOut("", 401)).toBe(true);
  });

  it("recognises a redirect to the sign-in page", () => {
    expect(looksSignedOut('<html><a href="/auth/signin">Sign in</a></html>', 200)).toBe(true);
  });

  it("leaves a normal response alone", () => {
    expect(looksSignedOut('{"jobs":[]}', 200)).toBe(false);
  });
});

describe("errorFor", () => {
  it("separates a challenge from a permission failure, though both are 403", () => {
    expect(errorFor(403, "/api/imagine", CHALLENGE).name).toBe("ChallengeError");
    expect(errorFor(403, "/api/imagine", '{"error":"forbidden"}').name).toBe("NotSignedInError");
  });

  it("calls a billing refusal what it is", () => {
    const error = errorFor(402, "/api/submit-jobs", "");
    expect(error.name).toBe("RateLimitError");
    expect(error.message).toMatch(/fast hours|subscription/);
  });

  it("maps the ordinary statuses", () => {
    expect(errorFor(400, "/api/submit-jobs", "{}").name).toBe("ValidationError");
    expect(errorFor(404, "/api/imagine", "{}").name).toBe("NotFoundError");
    expect(errorFor(429, "/api/imagine", "{}").name).toBe("RateLimitError");
    expect(errorFor(503, "/api/imagine", "{}").name).toBe("ServerError");
  });

  it("names the endpoint, so a failure says where it happened", () => {
    expect(errorFor(500, "/api/folders", "{}").toJSON().endpoint).toBe("/api/folders");
  });
});

describe("describeBody", () => {
  it("pulls the message out of a JSON error", () => {
    expect(describeBody('{"message":"prompt rejected"}')).toBe("prompt rejected");
  });

  it("strips tags out of an HTML error page rather than dumping it", () => {
    const described = describeBody("<html><script>var x=1</script><body><h1>Bad gateway</h1></body></html>");
    expect(described).toBe("Bad gateway");
    expect(described).not.toContain("<");
  });
});
