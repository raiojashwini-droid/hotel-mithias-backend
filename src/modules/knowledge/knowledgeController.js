import { listKnowledge as listKnowledgeService, uploadKnowledge as uploadKnowledgeService, deleteKnowledge as deleteKnowledgeService } from './knowledgeService.js';

export const listKnowledge = async (req, res, next) => {
  try {
    await listKnowledgeService(req, res, next);
  } catch (err) {
    next(err);
  }
};

export const uploadKnowledge = async (req, res, next) => {
  try {
    await uploadKnowledgeService(req, res, next);
  } catch (err) {
    next(err);
  }
};

export const deleteKnowledge = async (req, res, next) => {
  try {
    await deleteKnowledgeService(req, res, next);
  } catch (err) {
    next(err);
  }
};
