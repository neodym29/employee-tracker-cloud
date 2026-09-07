import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HELP_SECTIONS, HelpDrawer, InfoTip} from '../apps/web/help.js';

describe('in-app help', () => {
  it('covers the complete onboarding and reporting workflow', () => {
    expect(HELP_SECTIONS.map(section => section.title)).toEqual([
      'Create or join a workspace',
      'Install the local CLI',
      'Find and select repositories',
      'Select repositories to trace',
      'Review activity',
      'Generate a report',
    ]);
    expect(HELP_SECTIONS.map(section => section.destination)).toEqual(['', 'install', 'settings', 'settings', '', 'reports']);
    expect(HELP_SECTIONS.every(section => section.description && section.detail && section.action)).toBe(true);
  });

  it('styles a left-side drawer and keyboard-focusable information tips', () => {
    const css = fs.readFileSync(new URL('../apps/web/style.css', import.meta.url), 'utf8');
    expect(css).toContain('.help-drawer');
    expect(css).toContain('.info-tip-trigger:focus-visible');
  });

  it('exposes accessible tooltip and dialog semantics', () => {
    const tooltip = renderToStaticMarkup(React.createElement(InfoTip, {label: 'Workspace'}, 'Separate team area'));
    expect(tooltip).toContain('aria-label="More information: Workspace"');
    expect(tooltip).toContain('role="tooltip"');
    const drawer = renderToStaticMarkup(React.createElement(HelpDrawer, {hasWorkspace: true, onClose: () => {}, onNavigate: () => {}}));
    expect(drawer).toContain('role="dialog"');
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer.match(/<li/g)).toHaveLength(6);
  });
});
