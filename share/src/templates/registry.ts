/**
 * Template registry.
 *
 * Each entry is a JSX function rendered by Satori. Adding a new template
 * means dropping a `.tsx` file in this directory and adding it here. The
 * registry stays a static `Record` (not a glob import) so the bundler
 * tree-shakes unused templates and so type errors surface at build time.
 */

import type { ReactElement } from "react";
import DefaultTemplate, { type TemplateProps } from "./default.js";

export type TemplateComponent = (props: TemplateProps) => ReactElement;

export const TEMPLATES = {
  default: DefaultTemplate,
} as const satisfies Record<string, TemplateComponent>;

export type TemplateName = keyof typeof TEMPLATES;

export function isTemplateName(name: string): name is TemplateName {
  return name in TEMPLATES;
}

export function resolveTemplate(name: string | null): TemplateComponent {
  if (name && isTemplateName(name)) return TEMPLATES[name];
  return TEMPLATES.default;
}
