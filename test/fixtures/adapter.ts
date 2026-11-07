type Request={caseId:string;initial:{pending:boolean;published:boolean};actions:string[]};
let input='';for await(const chunk of process.stdin)input+=String(chunk);
const request=JSON.parse(input) as Request;
if(process.argv[2]==='env' && process.env.OBP_TEST_SECRET)process.exit(9);
const wrong=process.argv[2]==='wrong',state={pending:false,published:!wrong};
process.stdout.write(JSON.stringify({caseId:request.caseId,initial:request.initial,states:request.actions.map(()=>state),final:state,completed:true}));
