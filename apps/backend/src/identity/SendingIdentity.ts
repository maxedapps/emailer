import * as AWS from "alchemy/AWS";

export const sendingIdentityStack = "EmailerSending";

const sendingIdentityStage = "shared";

export const senderLogicalId = "EmailerSender";

export const sendingIdentity = AWS.SES.EmailIdentity.ref(senderLogicalId, {
  stack: sendingIdentityStack,
  stage: sendingIdentityStage,
});
