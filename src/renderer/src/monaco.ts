import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

// Bundle Monaco locally (no CDN): the desktop app must work offline.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()
  }
}

monaco.editor.defineTheme('viber-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0d1218',
    'editor.lineHighlightBackground': '#141b23',
    'editorGutter.background': '#0d1218',
    'diffEditor.insertedLineBackground': '#2ea04318',
    'diffEditor.removedLineBackground': '#f8514918'
  }
})

monaco.editor.defineTheme('viber-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f4f6fa',
    'editorGutter.background': '#ffffff',
    'diffEditor.insertedLineBackground': '#16a34a14',
    'diffEditor.removedLineBackground': '#dc262614'
  }
})

loader.config({ monaco })
