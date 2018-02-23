import * as tl from 'vsts-task-lib/task';
import * as vsts from 'vso-node-api/WebApi';
import Endpoint, { EndpointType } from './sonarqube/Endpoint';
import Scanner, { ScannerMode } from './sonarqube/Scanner';
import { toCleanJSON } from './helpers/utils';

export default async function prepareTask(endpoint: Endpoint, rootPath: string) {
  const scannerMode: ScannerMode = ScannerMode[tl.getInput('scannerMode')];
  const scanner = Scanner.getPrepareScanner(rootPath, scannerMode);

  const props: { [key: string]: string } = {};

  await populateBranchAndPrProps(endpoint, props);

  tl
    .getDelimitedInput('extraProperties', '\n')
    .filter(keyValue => !keyValue.startsWith('#'))
    .map(keyValue => keyValue.split(/=(.+)/))
    .forEach(([k, v]) => (props[k] = v));

  tl.setVariable('SONARQUBE_SCANNER_MODE', scannerMode);
  tl.setVariable('SONARQUBE_ENDPOINT', endpoint.toJson(), true);
  tl.setVariable(
    'SONARQUBE_SCANNER_PARAMS',
    toCleanJSON({
      ...endpoint.toSonarProps(),
      ...scanner.toSonarProps(),
      ...props
    })
  );

  await scanner.runPrepare();
}

async function populateBranchAndPrProps(endpoint: Endpoint, props: { [key: string]: string }) {
  const collectionUrl = tl.getVariable('System.TeamFoundationCollectionUri');
  const prId = tl.getVariable('System.PullRequest.PullRequestId');
  const provider = tl.getVariable('Build.Repository.Provider');
  if (prId) {
    if (endpoint.type === EndpointType.SonarCloud) {
      props['sonar.pullrequest.id'] = prId;
      props['sonar.pullrequest.base'] = branchName(
        tl.getVariable('System.PullRequest.TargetBranch')
      );
      props['sonar.pullrequest.branch'] = branchName(
        tl.getVariable('System.PullRequest.SourceBranch')
      );
      if (provider === 'TfsGit') {
        props['sonar.pullrequest.provider'] = 'vsts';
        props['sonar.pullrequest.vsts.instanceUrl'] = collectionUrl;
        props['sonar.pullrequest.vsts.project'] = tl.getVariable('System.TeamProject');
        props['sonar.pullrequest.vsts.gitRepo'] = tl.getVariable('Build.Repository.Name');
      } else if (provider === 'GitHub') {
        props['sonar.pullrequest.provider'] = 'github';
        props['sonar.pullrequest.github.repository'] = tl.getVariable('Build.Repository.Name');
      } else {
        tl.warning(`Unkwnow provider '${provider}'`);
        props['sonar.scanner.skip'] = 'true';
      }
    }
  } else if (endpoint.type === EndpointType.SonarCloud) {
    const defaultBranch = await getDefaultBranch(provider, collectionUrl);
    const currentBranch = tl.getVariable('Build.SourceBranch');
    if (defaultBranch !== currentBranch) {
      props['sonar.branch.name'] = branchName(currentBranch);
    }
  }
}

function branchName(fullName: string) {
  if (fullName.startsWith('refs/heads/')) {
    return fullName.substring('refs/heads/'.length);
  }
  return fullName;
}

/**
 * Query the repo to get the full name of the default branch.
 * @param collectionUrl
 */
async function getDefaultBranch(provider: string, collectionUrl: string) {
  const DEFAULT = 'refs/heads/master';
  if (provider !== 'TfsGit') {
    return DEFAULT;
  }
  try {
    const accessToken = getAuthToken();
    const credentialHandler = vsts.getBearerHandler(accessToken);
    const vssConnection = new vsts.WebApi(collectionUrl, credentialHandler);
    const repo = await vssConnection
      .getGitApi()
      .getRepository(tl.getVariable('Build.Repository.Name'), tl.getVariable('System.TeamProject'));
    tl.debug(`Default branch of this repository is '${repo.defaultBranch}'`);
    return repo.defaultBranch;
  } catch (e) {
    tl.warning("Unable to get default branch, defaulting to 'master': " + e);
    return DEFAULT;
  }
}

function getAuthToken() {
  const auth = tl.getEndpointAuthorization('SYSTEMVSSCONNECTION', false);
  if (auth.scheme.toLowerCase() === 'oauth') {
    return auth.parameters['AccessToken'];
  } else {
    throw new Error('Unable to get credential to perform rest API calls');
  }
}
