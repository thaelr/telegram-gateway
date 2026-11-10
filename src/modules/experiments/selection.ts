import { buildAssignment, chooseVariant, findActiveExperiment, parseAbTestAssignment } from './abTesting.js';
import type { AbTestSelection } from './abTesting.js';
import { config } from '../../config.js';
import type { MediaRepository } from '../../mediaCommerce/repositoryContract.js';

export async function resolveAbTestSelection(repository: MediaRepository, chatId: number,
    key: "subscription_offer",
  ): Promise<AbTestSelection | null> {
    const experiment = findActiveExperiment(config.EXPERIMENTS, key);
    if (!experiment) {
      return null;
    }

    const buildSelection = (
      assignment: NonNullable<ReturnType<typeof parseAbTestAssignment>>,
    ): AbTestSelection | null => {
      const params = experiment.variants[assignment.variant];
      if (!params) {
        console.error("[media_commerce] ab_test_variant_missing", {
          chat_id: chatId,
          key,
          starts_at: experiment.starts_at,
          version: experiment.version,
          variant: assignment.variant,
        });
        return null;
      }

      return {
        assignment_key: experiment.assignment_key,
        config: experiment,
        assignment,
        params,
      };
    };

    const existingAssignment = parseAbTestAssignment(
      await repository.loadAbTestAssignment(
        chatId,
        experiment.assignment_key,
      ),
    );
    if (existingAssignment) {
      return buildSelection(existingAssignment);
    }

    const assignment = buildAssignment({
      variant: chooseVariant(experiment.distribution),
    });
    const storedAssignment = parseAbTestAssignment(
      await repository.storeAbTestAssignment(
        chatId,
        experiment.assignment_key,
        assignment,
      ),
    ) ?? assignment;

    return buildSelection(storedAssignment);
  }
