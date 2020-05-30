import path from 'path'
import fs from 'fs'
import { WebviewPanel, Disposable, window, ViewColumn, Uri, ExtensionContext, workspace, EventEmitter, Selection, TextEditorRevealType } from 'vscode'
import i18n from '../i18n'
import { KeyInDocument, Config, Global, KeyDetector, CurrentFile } from '../core'
import { EXT_EDITOR_ID } from '../meta'
import { Protocol } from '../protocol'

export class EditorAttendant {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: EditorAttendant | undefined
  private static _onDidChanged = new EventEmitter<boolean>()
  public static onDidChange = EditorAttendant._onDidChanged.event

  private readonly _panel: WebviewPanel
  private readonly _protocol: Protocol
  private readonly _ctx: ExtensionContext
  private _disposables: Disposable[] = []
  private _mode: 'standalone' | 'currentFile' = 'standalone'

  get mode() {
    return this._mode
  }

  set mode(v) {
    if (this._mode !== v)
      this._mode = v
  }

  public editKey(keypath: string, locale?: string, index?: number) {
    this._protocol.editKey(keypath, locale, index)
  }

  public static createOrShow(ctx: ExtensionContext, column?: ViewColumn) {
    const panel = this.revive(ctx, undefined, column)
    panel.reveal(column || panel._panel.viewColumn)
    return panel
  }

  public static revive(ctx: ExtensionContext, panel?: WebviewPanel, column?: ViewColumn) {
    if (!EditorAttendant.currentPanel) {
      EditorAttendant.currentPanel = new EditorAttendant(ctx, panel, column)
      EditorAttendant._onDidChanged.fire(true)
    }

    return EditorAttendant.currentPanel
  }

  private constructor(ctx: ExtensionContext, panel?: WebviewPanel, column?: ViewColumn) {
    this._ctx = ctx
    this._panel = panel || window.createWebviewPanel(
      EXT_EDITOR_ID,
      i18n.t('editor.title'),
      column || ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          Uri.file(path.join(this._ctx.extensionPath, 'res')),
        ],
        retainContextWhenHidden: true,
      },
    )

    const webview = this._panel.webview

    this._protocol = new Protocol(
      async(message) => {
        this._panel.webview.postMessage(message)
      },
      async(message) => {
        switch (message.type) {
          case 'webview.refresh':
            this.init()
            break
          case 'navigate-key':
            this.navigateKey(message.data)
            break
        }
        return undefined
      },
      {
        get extendConfig() {
          return {
            extensionRoot: webview.asWebviewUri(Uri.file(Config.extensionPath!)).toString(),
          }
        },
        afterEditKey: () => {
          this.sendCurrentFileContext()
        },
      },
    )

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      msg => this._protocol.handleMessages(msg),
      null,
      this._disposables,
    )

    this._disposables.push(this._protocol)

    this.init()
  }

  public sendCurrentFileContext() {
    if (this.mode === 'standalone')
      return this._protocol.setContext({})

    const doc = window.activeTextEditor?.document

    if (!doc || !Global.isLanguageIdSupported(doc.languageId))
      return false

    let keys = KeyDetector.getKeys(doc) || []
    if (!keys.length)
      return false

    keys = keys.map(k => ({
      ...k,
      value: CurrentFile.loader.getValueByKey(k.key),
    }))

    const context = {
      filepath: doc.uri.fsPath,
      keys,
    }

    this._protocol.setContext(context)
    return true
  }

  private reveal(column?: ViewColumn) {
    column = column || (
      window.activeTextEditor
        ? window.activeTextEditor.viewColumn
        : undefined
    )
    this._panel.reveal(column)
  }

  async navigateKey(data: KeyInDocument & {filepath: string; keyIndex: number}) {
    if (!data.filepath)
      return

    this.editKey(data.key, undefined, data.keyIndex)
    const doc = await workspace.openTextDocument(Uri.file(data.filepath))
    const editor = await window.showTextDocument(doc, ViewColumn.One)
    editor.selection = new Selection(
      doc.positionAt(data.end),
      doc.positionAt(data.start),
    )
    editor.revealRange(editor.selection, TextEditorRevealType.InCenter)
  }

  public dispose() {
    EditorAttendant.currentPanel = undefined

    this._panel.dispose()

    Disposable.from(...this._disposables).dispose()

    EditorAttendant._onDidChanged.fire(false)
  }

  init() {
    this._panel.iconPath = Uri.file(
      path.join(this._ctx.extensionPath, 'res/logo.svg'),
    )
    this._panel.webview.html = fs.readFileSync(
      path.join(this._ctx.extensionPath, 'dist/editor/index.html'),
      'utf-8',
    )
  }

  get visible() {
    return this._panel.visible
  }
}