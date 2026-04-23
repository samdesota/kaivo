import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'

export function languageForPath(path: string): Extension | null {
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() ?? ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return javascript({ jsx: true, typescript: true })
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true })
    case 'json':
    case 'jsonc':
      return json()
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell)
    default:
      // dotfiles and shell-like by name
      if (base === 'dockerfile' || base.startsWith('.bashrc') || base.startsWith('.zshrc')) {
        return StreamLanguage.define(shell)
      }
      return null
  }
}
