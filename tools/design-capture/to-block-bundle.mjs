// to-block-bundle.mjs — assemble a complete BLOCK-THEME output bundle from a capture.
//
// The `target: 'block-theme'` branch of the converter. Ties the two emitters together:
//   - to-block-theme.mjs → the theme SHELL (style.css + theme.json + templates + parts + patterns)
//   - to-blocks.mjs      → the page BODY as core block markup
// into one JSON bundle the plugin installs (FW_Site_Converter_Blocks::install_block_theme):
//
//   { target:'block-theme', theme:{ slug, files:{ '<rel path>': '<content>' } },
//     page:{ title, content } }
//
// Core-first and plugin-independent (see the AI Dev Kit "Block Theme Roadmap").

import { toBlocks } from './to-blocks.mjs';
import { toBlockTheme } from './to-block-theme.mjs';

/**
 * @param {object} capture  the design-capture
 * @param {object} [opts]   { name, title }
 * @returns {{ target:'block-theme', theme:{ slug:string, files:Record<string,string> }, page:{ title:string, content:string } }}
 */
export function toBlockBundle(capture, opts = {}) {
  const { slug, files } = toBlockTheme(capture, opts);
  const content = toBlocks(capture, { vocabulary: opts.vocabulary });
  const logo = (capture && capture.header && capture.header.logo) || null;
  const logoUrl = logo && logo.type === 'image' && logo.src ? String(logo.src).trim() : '';
  const brandText =
    (logo && (logo.text || '').trim()) ||
    (capture && capture.meta && (capture.meta.title || '').trim()) ||
    '';
  const title = opts.title || brandText || 'Home';
  return {
    target: 'block-theme',
    theme: { slug, files },
    page: { title: String(title || 'Home'), content },
    // Site identity the installer applies: the logo becomes the custom_logo theme mod that
    // core/site-logo renders from; the title becomes blogname (site-title fallback + browser chrome).
    site: { title: String(brandText || title || ''), logo: logoUrl },
  };
}

export default { toBlockBundle };
