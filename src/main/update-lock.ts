export type UpdateOperation = 'desktop-update' | 'dsh-update' | 'dsh-rollback'

export class UpdateLock {
  private active: UpdateOperation | null = null

  public get activeOperation(): UpdateOperation | null {
    return this.active
  }

  public async run<T>(operation: UpdateOperation, task: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error(`Another update is already active: ${this.active}`)
    this.active = operation
    try {
      return await task()
    } finally {
      this.active = null
    }
  }
}
