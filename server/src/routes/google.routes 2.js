const { randomBytes, createHash } = require("node:crypto");
const router = require("express").Router();
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { loginWithGoogle } = require("../services/auth.service");

const flowCookie = "invenkai_google";
const audience = "invenkai-google-flow";
router.use(cookieParser());

router.use((req, res, next) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CLIENT_URL, JWT_SECRET } =
    process.env;
  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !CLIENT_URL ||
    !JWT_SECRET
  ) {
    return res.status(503).json({ message: "Google sign-in is unavailable." });
  }
  const redirect = new URL("/home", CLIENT_URL);
  res.locals.google = new OAuth2Client(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    redirect.href,
  );
  res.locals.cookie = {
    httpOnly: true,
    sameSite: "lax",
    secure: redirect.protocol === "https:",
    path: "/api/auth/google",
  };
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/", (req, res) => {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const flow = jwt.sign({ state, verifier, nonce }, process.env.JWT_SECRET, {
    audience,
    expiresIn: "10m",
  });
  res.cookie(flowCookie, flow, { ...res.locals.cookie, maxAge: 600000 });
  res.redirect(
    res.locals.google.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  );
});

router.post("/callback", async (req, res) => {
  const { code, state } = req.body ?? {};
  let flow;
  try {
    flow = jwt.verify(req.cookies[flowCookie], process.env.JWT_SECRET, {
      audience,
      algorithms: ["HS256"],
    });
  } catch {
    return res
      .status(400)
      .json({ message: "Google sign-in expired. Please try again." });
  }
  if (state !== flow.state || typeof code !== "string" || !code) {
    return res
      .status(400)
      .json({
        message: "Google sign-in could not be confirmed. Please try again.",
      });
  }
  res.clearCookie(flowCookie, res.locals.cookie);
  const client = res.locals.google;
  let profile;
  try {
    const { tokens } = await client.getToken({
      code,
      codeVerifier: flow.verifier,
    });
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    profile = ticket.getPayload();
    if (profile?.nonce !== flow.nonce) throw new Error("Invalid Google nonce");
  } catch {
    return res
      .status(400)
      .json({ message: "Google sign-in failed. Please try again." });
  }
  try {
    res.json(await loginWithGoogle(profile));
  } catch (error) {
    if (error.statusCode)
      return res.status(error.statusCode).json({ message: error.message });
    return res.status(500).json({ message: "Could not sign in to InvenKai." });
  }
});

module.exports = router;
