/**
 * lib/auth — who is calling, and are they allowed to.
 *
 *   requireCreator(req, "listings:write")   bearer x4c_live_… / x4s_live_… → creator row
 *   insertApiKey / rotateAgentKey           minting (D14, FR-54)
 *   revokeSessionKeys / revokeApiKeyByHash  revocation (FR-57)
 *   walletFrom(req) / requireWallet(req)    X-Wallet-Signature → address
 *   issueChallenge / consumeChallenge       the signed-challenge primitive
 *   requireStepUp(creator, body.step_up)    FR-5 destructive actions
 *   enforceLimit(name, key)                 PRD §9 limits
 */

export * from "./challenge";
export * from "./wallet-signature";
export * from "./api-key";
export * from "./step-up";
export * from "./rate-limit";
