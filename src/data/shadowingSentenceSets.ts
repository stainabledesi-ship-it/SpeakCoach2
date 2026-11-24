import type { ShadowingDifficulty, ShadowingSentence } from './shadowingBank';
import { SHADOWING_BANK_DATA } from './shadowingBankData';

type UploadedSentenceGroup = { value: ShadowingSentence[] };
const uploadedGroups = SHADOWING_BANK_DATA as unknown as UploadedSentenceGroup[];

function buildUploadedSets(difficulty: ShadowingDifficulty): ShadowingSentence[][] {
  return uploadedGroups
    .filter(group => group.value[0]?.difficulty === difficulty)
    .map(group => group.value.map(sentence => ({
      ...sentence,
      usefulVocabulary: sentence.usefulVocabulary?.map(item => ({ ...item }))
    })));
}

export const BUILTIN_SHADOWING_SETS: Record<ShadowingDifficulty, ShadowingSentence[][]> = {
  easy: buildUploadedSets('easy'),
  medium: buildUploadedSets('medium'),
  hard: buildUploadedSets('hard')
};

export function getInitialShadowingSets(difficulty: ShadowingDifficulty): ShadowingSentence[][] {
  return BUILTIN_SHADOWING_SETS[difficulty].map(set => set.map(sentence => ({
    ...sentence,
    usefulVocabulary: sentence.usefulVocabulary?.map(item => ({ ...item }))
  })));
}
