import { Router } from "express";
import { requireAuth } from "../auth.js";
import {
  EXPORT_LIMITS,
  createExportJob,
  getExportDownload,
  getExportJob,
} from "../exportJobs.js";

const router = Router();

router.post("/", requireAuth, async (req, res) => {
  try {
    const job = await createExportJob({
      type: req.body?.type,
      query: req.body?.query ?? {},
      user: req.user,
    });

    return res.status(202).json({
      ...job,
      limits: EXPORT_LIMITS,
      message: job.status === "pending"
        ? "Your export is being prepared."
        : "An export with the same filters is already in progress.",
    });
  } catch (err) {
    return res.status(Number(err?.status || 500)).json({
      error: err?.message || "Could not create export job.",
      total: err?.total ?? undefined,
      limit: err?.limit ?? undefined,
      limits: EXPORT_LIMITS,
    });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const job = await getExportJob(req.params.id, req.user);
    if (!job) {
      return res.status(404).json({ error: "Export job not found." });
    }

    return res.json({
      ...job,
      limits: EXPORT_LIMITS,
    });
  } catch (err) {
    return res.status(Number(err?.status || 500)).json({
      error: err?.message || "Could not load export job.",
      limits: EXPORT_LIMITS,
    });
  }
});

router.get("/:id/download", requireAuth, async (req, res) => {
  try {
    const file = await getExportDownload(req.params.id, req.user);
    res.setHeader("Content-Type", file.mimeType);
    return res.download(file.filePath, file.fileName);
  } catch (err) {
    return res.status(Number(err?.status || 500)).json({
      error: err?.message || "Could not download export file.",
    });
  }
});

export default router;
