import { registerDeployIpc } from './deploy'
import { registerDialogIpc } from './dialog'
import { registerGitIpc } from './git'
import { registerProjectIpc } from './project'
import { registerTeamRepoIpc } from './team-repo'
import { registerUpdateIpc } from './update'

export function registerIpc(): void {
  registerProjectIpc()
  registerDeployIpc()
  registerGitIpc()
  registerTeamRepoIpc()
  registerDialogIpc()
  registerUpdateIpc()
}
