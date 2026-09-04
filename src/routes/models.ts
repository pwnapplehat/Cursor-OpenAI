import { Router } from "express";
import { HttpError } from "../errors";
import type { ModelCatalog } from "../cursor/modelCatalog";
import type { AppConfig } from "../config";
import { parseAllowedModels } from "../config";

export function createModelsRouter(modelCatalog: ModelCatalog, config: AppConfig): Router {
  const router = Router();

  const listOptions = () => ({
    mode: config.modelListMode,
    allowedModels: parseAllowedModels(config.allowedModels),
  });

  router.get("/v1/models", (req, res, next) => {
    void (async () => {
      try {
        if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
        const list = await modelCatalog.toOpenAIModelList(req.cursorApiKey, listOptions());
        res.json(list);
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get("/v1/models/:id", (req, res, next) => {
    void (async () => {
      try {
        if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
        const found = await modelCatalog.lookupOpenAIModel(req.cursorApiKey, req.params.id ?? "", listOptions());
        if (!found) throw HttpError.notFound(`Model "${req.params.id}" was not found in your Cursor account's catalog.`);
        res.json(found);
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
