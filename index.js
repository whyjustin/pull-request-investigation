const request = require('request-promise-native');
const fs = require('fs');
var stat = require('simple-statistics')

const settings = require('./settings.json');
const githubApi = 'https://api.github.com';

// https://coderwall.com/p/nilaba/simple-pure-javascript-array-unique-method-with-5-lines-of-code
Array.prototype.unique = function() {
  return this.filter(function (value, index, self) { 
    return self.indexOf(value) === index;
  });
}

async function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function GithubRequest(apiEndpoint) {
  const response = await request.get(`${githubApi}/repos/${settings.githubRepository}/${apiEndpoint}`,
  {
    'auth': {
      'user': settings.githubUsername,
      'pass': settings.githubPassword,
    },
    'headers': {
      'User-Agent': 'Pull-Request-Investigator'
    }
  });
  return Promise.resolve(JSON.parse(response));
}

async function updateComments(newPull, page) {
  page = page || 1;
  newPull.comments = newPull.comments || [];

  const comments = await GithubRequest(`pulls/${newPull.number}/comments?page=${page}`);
  comments.forEach((comment) => {
    newPull.comments.push({
      id: comment.id,
      commit_id: comment.commit_id,
      in_reply_to_id: comment.in_reply_to_id,
      user: comment.user.login,
      body: comment.body,
      created_at: Date.parse(comment.created_at)
    });
  });

  if (comments.length > 0) {
    await sleep(100);
    page++;
    await updateComments(newPull, page);
  }
}

async function updateCommits(newPull, page) {
  page = page || 1;
  newPull.commits = newPull.commits || [];

  const commits = await GithubRequest(`pulls/${newPull.number}/commits?page=${page}`);
  commits.forEach((commit) => {
    newPull.commits.push({
      sha: commit.sha,
      user: commit.committer.login,
      created_at: Date.parse(commit.commit.committer.date)
    });
  });

  if (commits.length > 0) {
    await sleep(100);
    page++;
    await updateCommits(newPull, page);
  }
}

async function updatePulls(existingPulls, page) {
  page = page || 1;
  const pulls = await GithubRequest(`pulls?state=closed&page=${page}`);

  let queryNextPage = false;
  for (let i = 0; i < pulls.length; i++) {
    const pull = pulls[i];
    const pullExists = existingPulls.some((existingPull) => {
      return existingPull.id === pull.id;
    });
    queryNextPage = queryNextPage || !pullExists;
    if (!pullExists) {
      try {
        const newPull = {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          created_at: Date.parse(pull.created_at),
          closed_at: Date.parse(pull.closed_at),
          user: pull.user.login
        };
        await updateComments(newPull);
        await updateCommits(newPull);
        existingPulls.push(newPull);
      } catch (error) {
        // If anything fails in fetching comments or commits, exclude PR
        console.log(error);
      }
    }
  };

  if (queryNextPage) {
    await sleep(100);
    page++;
    await updatePulls(existingPulls, page);
  }
}

async function investigateRepository() {
  const pullsJsonPath = `${settings.githubRepository}/pulls.json`;
  const existingPulls = fs.existsSync(pullsJsonPath) ? JSON.parse(fs.readFileSync(pullsJsonPath)) : [];

  await updatePulls(existingPulls);
  fs.writeFileSync(pullsJsonPath, JSON.stringify(existingPulls));

  console.log(`All Pull Requests`);
  logStatistics(existingPulls);
  
  const reviewedPulls = existingPulls.filter((pull) => {
    return pull.comments.map((comment) => {
      return comment.user
    }).unique().length > 0;
  });
  console.log('Reviewed Pull Requests');
  logStatistics(reviewedPulls);

  const maxReviews = stat.max(existingPulls.map((pull) => {
    return pull.comments.map((comment) => {
      return comment.user
    }).unique().length
  }));
  for (let i = 0; i <= maxReviews; i++) {
    const specificReviewCountPulls = existingPulls.filter((pull) => {
      return pull.comments.map((comment) => {
        return comment.user
      }).unique().length === i;
    });
    console.log(`${i} Reviewed Pull Requests`);
    logStatistics(specificReviewCountPulls);
  }
}

function logStatistics(pullRequestSet) {
  const reviewerCounts = pullRequestSet.map((pull) => {
    return pull.comments.map((comment) => {
      return comment.user
    }).unique().length;
  });

  console.log(`PR Count: ${pullRequestSet.length}`);
  console.log(`Average Reviewers: ${stat.mean(reviewerCounts)}`);
  console.log(`Variance Reviewers: ${stat.variance(reviewerCounts)}`);

  const timeToClose = pullRequestSet.map((reviewedPull) => {
    return reviewedPull.closed_at - reviewedPull.created_at;
  });
  console.log(`Average Time To Close: ${stat.mean(timeToClose) / 1000 / 60 / 60} hours`)

  const firstCommentToClose = {};
  const commitsAfterReviewDone = {};
  pullRequestSet.forEach((reviewedPull) => {
    if (reviewedPull.comments.length === 0) {
      return;
    }

    const orderedComments = reviewedPull.comments.sort((a, b) => {
      return a.created_at - b.created_at;
    });
    const reviewers = orderedComments.map((comment) => {
      return comment.user
    }).unique();

    for (var i = 0; i < reviewers.length; i++) {
      const reviewer = reviewers[i];
      const reviewerComments = orderedComments.filter((comment) => {
        return comment.user === reviewer;
      });

      firstCommentToClose[i] = firstCommentToClose[i] || [];
      firstCommentToClose[i].push(reviewedPull.closed_at - reviewerComments[0].created_at);
      const lastCommentTimeReviewer = stat.max(reviewerComments.map((comment) => {
        return comment.created_at;
      }));
      const commitsAfterReview = reviewedPull.commits.filter((commit) => {
        return commit.created_at > lastCommentTimeReviewer;
      }).length;

      commitsAfterReviewDone[i] = commitsAfterReviewDone[i] || [];
      commitsAfterReviewDone[i].push(commitsAfterReview);
    }
  });
  Object.keys(firstCommentToClose).forEach((i) => {
    const reviewerFirstCommentToClose = firstCommentToClose[i];
    console.log(`Average First Comment From Reviewer #${i} To Close: ${stat.mean(reviewerFirstCommentToClose) / 1000 / 60 / 60} hours`);
  });
  Object.keys(commitsAfterReviewDone).forEach((i) => {
    const commitsAfterReviewerDone = commitsAfterReviewDone[i];
    console.log(`Average Commits After Review From Reviewer #${i} Complete: ${stat.mean(commitsAfterReviewerDone)}`);
  });
}

if (!fs.existsSync(settings.githubRepository)) {
  fs.mkdirSync(settings.githubRepository.split('/')[0]);
  fs.mkdirSync(settings.githubRepository);
}
investigateRepository();
