/**
 * CodeBuild buildspec for the WhatsApp VoiceNotes Runtime image (TypeScript).
 *
 * The runtime is a Node/TypeScript service; reproducibility is enforced INSIDE
 * the Docker build by `npm ci` against the committed `package-lock.json` (npm ci
 * fails if the lockfile is out of sync), so no separate pre-build lock-gate is
 * needed. The old Python `pip install -r requirements.txt` + `pip freeze` diff
 * gate was removed with the migration off the Python/strands runtime.
 *
 * - docker buildx against ARM64 (AgentCore Runtime requires ARM64), push to
 *   ECR (`$IMAGE_REPO_URI:latest`).
 *
 * Env vars the project injects (set in voicenotes-stack.ts):
 *   - IMAGE_REPO_URI   - from the ECR repo created in this stack
 *   - AWS_REGION       - us-east-1 (CodeBuild-provided)
 *   - AWS_ACCOUNT_ID   - resolved via Aws.ACCOUNT_ID
 *
 * All commands run inside CodeBuild's ARM64 standard image.
 */
export const buildspec = {
  version: '0.2',
  env: {
    variables: {
      DOCKER_BUILDKIT: '1',
    },
  },
  phases: {
    pre_build: {
      commands: [
        'echo "=== pre_build: sanity checks ==="',
        'node --version',
        'aws --version',
        'docker --version',
        'echo "IMAGE_REPO_URI=${IMAGE_REPO_URI}"',
        'echo "=== pre_build: source layout ==="',
        'pwd && ls -la',
        'echo "=== pre_build: ECR login ==="',
        'aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${IMAGE_REPO_URI%%/*}"',
      ],
    },
    build: {
      commands: [
        'echo "=== build: docker buildx arm64 ==="',
        'docker buildx build --platform=linux/arm64 -t "${IMAGE_REPO_URI}:latest" --load .',
      ],
    },
    post_build: {
      commands: [
        'echo "=== post_build: docker push ==="',
        'docker push "${IMAGE_REPO_URI}:latest"',
        'echo "=== post_build: done ==="',
      ],
    },
  },
};
