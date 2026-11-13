import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { promises as fs } from 'fs'
import { basename } from 'path'
import type {
  ExportProjectResult,
  ImportProjectResult,
  Project,
  ProjectExportFile,
  ProjectExportOptions,
  SelectImportResult
} from '@shared/types'
import { normalizeProject, nowIso } from '@shared/defaults'
import { configStore } from '../services/config-store'
import { removeProjectArtifacts } from '../services/artifact-store'
import { resolveOperator } from '../services/operator'
import {
  buildImportedProject,
  collectImportWarnings,
  type ImportedSecretMap
} from '../services/project-import'
import { decryptJson, encryptJson } from '../services/transfer-crypto'

interface PendingImport {
  filePath: string
  payload: ProjectExportFile
}

let pendingImport: PendingImport | null = null

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sanitizeFileName(name: string): string {
  return (name || 'project').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'project'
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:list', () => configStore.listProjects())
  ipcMain.handle('project:save', async (_event, project: Project) => configStore.saveProject(project))
  ipcMain.handle('project:delete', async (_event, id: string) => {
    await configStore.deleteProject(id)
    await removeProjectArtifacts(id)
  })
  ipcMain.handle('project:operator', async (_event, projectId: string) => {
    const project = configStore.getProjectRaw(projectId)
    if (!project) return ''
    return resolveOperator(project)
  })

  ipcMain.handle(
    'project:export',
    async (_event, projectId: string, options: ProjectExportOptions): Promise<ExportProjectResult> => {
      const project = configStore.getProjectRaw(projectId)
      if (!project) return { saved: false, message: '项目不存在' }

      const includeSecrets = Boolean(options?.includeSecrets)
      if (includeSecrets && (!options.passphrase || options.passphrase.length < 6)) {
        return { saved: false, message: '加密口令至少 6 位' }
      }

      const payload: ProjectExportFile = {
        format: 'deploye-project',
        version: 1,
        exportedAt: nowIso(),
        project: normalizeProject(project)
      }

      if (includeSecrets) {
        const secrets: ImportedSecretMap = {}
        for (const target of project.targets) {
          const secret = configStore.getSecret(target.id)
          if (secret.password || secret.passphrase) secrets[target.id] = secret
        }
        if (Object.keys(secrets).length > 0) {
          payload.secrets = encryptJson(secrets, options.passphrase as string)
        }
      }

      const saveOptions: SaveDialogOptions = {
        title: '导出项目配置',
        defaultPath: `${sanitizeFileName(project.name)}.deploye.json`,
        filters: [{ name: 'Deploye 项目', extensions: ['json'] }]
      }
      const win = focusedWindow()
      const result = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (result.canceled || !result.filePath) return { saved: false, canceled: true }

      await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
      return {
        saved: true,
        path: result.filePath,
        includedSecrets: Boolean(payload.secrets)
      }
    }
  )

  ipcMain.handle('project:selectImportFile', async (): Promise<SelectImportResult> => {
    const openOptions: OpenDialogOptions = {
      title: '导入项目配置',
      filters: [{ name: 'Deploye 项目', extensions: ['json'] }],
      properties: ['openFile']
    }
    const win = focusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, openOptions)
      : await dialog.showOpenDialog(openOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }

    const filePath = result.filePaths[0]
    let payload: ProjectExportFile
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      payload = JSON.parse(raw) as ProjectExportFile
      if (
        payload?.format !== 'deploye-project' ||
        !payload.project ||
        typeof payload.project !== 'object'
      ) {
        return { canceled: false, error: '文件不是有效的 Deploye 项目配置' }
      }
    } catch {
      return { canceled: false, error: '无法读取文件或 JSON 解析失败' }
    }

    pendingImport = { filePath, payload }
    return {
      canceled: false,
      fileName: basename(filePath),
      needsPassphrase: Boolean(payload.secrets),
      projectName: payload.project.name
    }
  })

  ipcMain.handle(
    'project:importSelected',
    async (_event, passphrase?: string): Promise<ImportProjectResult> => {
      if (!pendingImport) {
        return { ok: false, message: '没有待导入的文件，请重新选择' }
      }
      const payload = pendingImport.payload
      let secrets: ImportedSecretMap | undefined

      if (payload.secrets) {
        if (!passphrase) {
          return { ok: false, needsPassphrase: true, message: '该文件包含加密凭据，请输入口令' }
        }
        try {
          secrets = decryptJson<ImportedSecretMap>(payload.secrets, passphrase)
        } catch {
          return { ok: false, needsPassphrase: true, message: '口令错误或文件已损坏' }
        }
      }

      const project = buildImportedProject(payload.project, secrets)
      const warnings = await collectImportWarnings(project)
      const saved = await configStore.saveProject(project)
      pendingImport = null
      return { ok: true, project: saved, warnings }
    }
  )
}
