import type { NotificationShape } from '@aegis/shared-types';

/**
 * Template engine (W3-12) — a tiny, dependency-free named-template registry with `{{var}}`
 * interpolation. The renderer (`content-map.ts`) stays the typed, total-over-the-union source of
 * truth for which template a code maps to; this engine is the reusable SUBSTITUTION primitive a
 * template uses to turn a stored `MessageTemplate` (subject + body with placeholders) into a
 * `RenderedContent`. Unknown placeholders render to empty string (never the literal `{{var}}`), so a
 * missing variable degrades to a blank rather than leaking template syntax to a recipient.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Substitute every `{{var}}` in `template` from `vars` (missing/undefined ⇒ empty string). */
export function interpolate(template: string, vars: NotificationShape.TemplateVars): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** A named-template registry: register templates per event type, render to `RenderedContent`. */
export class TemplateEngine {
  private readonly templates = new Map<string, NotificationShape.MessageTemplate>();

  constructor(templates: readonly NotificationShape.MessageTemplate[] = []) {
    for (const template of templates) this.register(template);
  }

  /** Register (or replace) a named template. */
  register(template: NotificationShape.MessageTemplate): this {
    this.templates.set(template.name, template);
    return this;
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * Render a named template with `vars` into a `RenderedContent`. Throws if the template name is not
   * registered — a missing template is a programmer error (the content-map resolves a known name per
   * code), never a silent empty send.
   */
  render(name: string, vars: NotificationShape.TemplateVars): NotificationShape.RenderedContent {
    const template = this.templates.get(name);
    if (!template) throw new Error(`No notification template registered for '${name}'`);
    return {
      subject: interpolate(template.subject, vars),
      body: interpolate(template.body, vars),
      ...(template.html ? { html: interpolate(template.html, vars) } : {}),
      template: template.name,
    };
  }
}
