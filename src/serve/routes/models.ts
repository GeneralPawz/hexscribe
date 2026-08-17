/** GET /v1/models -- what clients probe to discover the model id to send. */

import { listModels } from '../models.ts'
import type { Handler } from '../router.ts'
import type { ServeDeps } from '../types.ts'

export function createModelsHandler(deps: ServeDeps): Handler {
  return async () => Response.json(listModels(deps))
}
