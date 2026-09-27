// Expected empty-conversation outcomes are data, not unsanitized exception text.
const problems=new Map([
 ['Current conversation has no direct user message after the latest reset',{status:'unavailable',code:'NO_CURRENT_USER',message:'Send a new message directly in this session after the reset, then create a new export. Messages forwarded from another session do not start a new conversation.'}],
 ['No conversation entries available',{status:'unavailable',code:'EMPTY_CONVERSATION',message:'This session has no conversation entries yet. Send a message here, then create a new export.'}],
]);
export async function withExpectedExportProblem(work){
 try{return await work();}catch(error){
  const problem=error instanceof Error?problems.get(error.message):undefined;
  if(problem)return {...problem};
  // Unexpected failures keep the Gateway's normal sanitized-error boundary.
  throw error;
 }
}
