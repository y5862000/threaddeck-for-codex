"use strict";

const DEFINITE_FALLBACK_CODES = new Set([
  "MICRO_UNAVAILABLE",
  "MICRO_CAPABILITY_UNAVAILABLE"
]);

function definiteMicroFallback(error) {
  return error?.delivery === "none" && DEFINITE_FALLBACK_CODES.has(error?.code);
}

function deliveredMicroError(error, operation = "Micro command verification") {
  if (error && typeof error === "object") {
    error.delivery = "unknown";
    return error;
  }
  const wrapped = new Error(`${operation} failed after the command was delivered.`);
  wrapped.code = "MICRO_POST_DELIVERY_ERROR";
  wrapped.delivery = "unknown";
  return wrapped;
}

async function verifyAfterMicroDelivery(operation, label) {
  try {
    return await operation();
  } catch (error) {
    throw deliveredMicroError(error, label);
  }
}

class CodexControlPlane {
  constructor(options = {}) {
    this.micro = options.micro ?? null;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.unavailableCooldownMs = options.unavailableCooldownMs ?? 3000;
    this.microUnavailableUntilMs = 0;
    this.lastSnapshot = null;
    this.lastHealth = {
      backend: "legacy",
      connected: false,
      checkedAtMs: null,
      reason: null
    };
  }

  shouldTryMicro() {
    return Boolean(this.micro) && this.now() >= this.microUnavailableUntilMs;
  }

  noteMicroSuccess(snapshot = null) {
    if (snapshot) this.lastSnapshot = snapshot;
    this.microUnavailableUntilMs = 0;
    this.lastHealth = {
      backend: "micro",
      connected: true,
      checkedAtMs: this.now(),
      reason: null
    };
  }

  noteMicroFailure(error) {
    const definite = definiteMicroFallback(error);
    if (definite) this.microUnavailableUntilMs = this.now() + this.unavailableCooldownMs;
    this.lastHealth = {
      backend: definite ? "legacy" : "micro",
      connected: false,
      checkedAtMs: this.now(),
      reason: error?.code ?? "MICRO_ERROR"
    };
  }

  health() {
    return {
      ...this.lastHealth,
      snapshot: this.lastSnapshot
    };
  }

  async refreshReadOnly(options = {}) {
    if (!this.shouldTryMicro() && options.force !== true) return null;
    try {
      const snapshot = await this.micro.refreshReadOnly();
      this.noteMicroSuccess(snapshot);
      return snapshot;
    } catch (error) {
      this.noteMicroFailure(error);
      if (!options.quiet) this.log(`Micro read-only refresh failed: ${error?.message ?? "unknown error"}`);
      return null;
    }
  }

  async execute(capability, operations, options = {}) {
    const microOperation = operations?.micro;
    const legacyOperation = operations?.legacy;
    if (typeof microOperation === "function" && this.shouldTryMicro()) {
      try {
        const value = await microOperation(this.micro, this.lastSnapshot);
        this.noteMicroSuccess();
        return { ok: value !== false, backend: "micro", value };
      } catch (error) {
        this.noteMicroFailure(error);
        if (!definiteMicroFallback(error)) {
          this.log(`Micro ${capability} failed without safe fallback: ${error?.message ?? "unknown error"}`);
          return { ok: false, backend: "micro", error, ambiguous: true };
        }
        if (!options.quiet) {
          this.log(`Micro ${capability} is unavailable; using the legacy adapter.`);
        }
      }
    }
    if (typeof legacyOperation !== "function") {
      return { ok: false, backend: "none", unavailable: true };
    }
    try {
      const value = await legacyOperation();
      return { ok: value !== false, backend: "legacy", value };
    } catch (error) {
      return { ok: false, backend: "legacy", error };
    }
  }

  close() {
    this.micro?.close?.();
  }
}

module.exports = {
  CodexControlPlane,
  definiteMicroFallback,
  deliveredMicroError,
  verifyAfterMicroDelivery
};
