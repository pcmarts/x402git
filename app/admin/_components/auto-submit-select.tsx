"use client";

/**
 * A `<select>` that applies itself. It stays a plain field in a GET form, so with
 * scripting off the form's own submit button still applies the choice.
 */

import type { ComponentProps } from "react";

export function AutoSubmitSelect(props: ComponentProps<"select">) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
