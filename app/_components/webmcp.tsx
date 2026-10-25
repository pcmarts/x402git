/**
 * app/_components/webmcp.tsx — the listing, as tools, for an agent driving a browser.
 *
 * WebMCP (`navigator.modelContext`, webmachinelearning.github.io/webmcp) is the browser
 * side of the same idea as /api/mcp: an agent that is *on* this page can call named
 * tools instead of scraping the DOM. This registers four read-only ones for the listing
 * being viewed.
 *
 * Three rules keep it inside this project's contract rather than beside it.
 *
 * 1. **It is not content.** Everything these tools return is already in the server HTML
 *    (§14.1) and already on the free API. With scripting off, or in a browser without
 *    the API, nothing is registered and nothing is lost — the page is unchanged and the
 *    reading at `?view=agent` is still complete.
 * 2. **Read-only.** No tool signs, pays or mutates. Buying needs a key the page does not
 *    have and must not ask for: `how_to_buy` hands back the endpoint and the skill URL
 *    and lets the agent do it out of band, exactly as /api/mcp's `purchase` requires the
 *    signature to be made locally.
 * 3. **No second copy of the API.** Each tool is one `fetch` of a public route on this
 *    origin — the same routes `/docs` documents — so the answers cannot drift from what
 *    a caller outside the browser would get.
 *
 * Inline, like every other behaviour on the listing page (buy-bar.tsx, readme-more.tsx),
 * and written to run on the first parse: the scanner that looks for tools "on page load"
 * and an agent that attaches later both find them registered.
 *
 * The API is young and still moving: `registerTool` is the current shape, and the
 * earlier `provideContext({ tools })` is tried as a fallback. Both are wrapped, so a
 * browser that ships a third spelling costs a caught exception and nothing else.
 */

type Props = { owner: string; slug: string };

/**
 * `owner` and `slug` are the only inputs, JSON-embedded rather than read from the DOM.
 * `</script` cannot appear in a handle or a slug (both are `[a-z0-9-]`), but the escape
 * is here because the day that stops being true should not be a script injection.
 */
export function webMcpScript(owner: string, slug: string): string {
  const args = JSON.stringify({ owner, slug }).replace(/</g, "\\u003c");

  return `(function(){var mc=navigator.modelContext;if(!mc)return;var L=${args};
var base=location.origin,ref=L.owner+"/"+L.slug;
function text(v){return{content:[{type:"text",text:typeof v==="string"?v:JSON.stringify(v,null,2)}]}}
function get(path){return fetch(base+path,{headers:{accept:"application/json"}}).then(function(r){
return r.json().then(function(b){return r.ok?text(b):text({error:b,status:r.status})})})}
var empty={type:"object",properties:{},required:[]};
var tools=[
{name:"get_listing_manifest",description:"The full public manifest of the repository on this page ("+ref+"): file tree, sizes, licence, dependencies, security-scan result and the sha256 of the exact artifact a buyer receives. Free, and the thing to read before deciding to buy.",inputSchema:empty,
execute:function(){return get("/api/label/"+ref)}},
{name:"get_listing_price",description:"The latest version of "+ref+", when it was published, its price in micro-USDC (9000000 is $9.00) and its update price (0 means updates are included for life).",inputSchema:empty,
execute:function(){return get("/api/v/"+ref)}},
{name:"get_listing_releases",description:"The public release log for "+ref+": every version, when it shipped and what changed.",inputSchema:empty,
execute:function(){return get("/api/v/"+ref+"/releases")}},
{name:"how_to_buy_listing",description:"How to actually buy "+ref+" with USDC over x402. Returns the paid endpoint and the step-by-step skill. Payment is signed with the caller's own key, never in this page.",inputSchema:empty,
execute:function(){return Promise.resolve(text({resource_endpoint:base+"/api/r/"+ref,version_endpoint:base+"/api/v/"+ref,skill:base+"/.well-known/agent-skills/buy-a-repo/SKILL.md",mcp_endpoint:base+"/api/mcp",
steps:["GET the resource endpoint. It answers 402 with the x402 payment requirements and a quote to echo.","Sign those requirements with your own wallet. This site never sees a private key.","Repeat the GET with the signed payment attached. Access is granted once it settles on chain.","The skill above has the exact headers, and the 200 carries a five-minute download URL plus the sha256 to verify it against."]}))}}];
try{
if(typeof mc.registerTool==="function"){for(var i=0;i<tools.length;i++)mc.registerTool(tools[i]);}
else if(typeof mc.provideContext==="function"){mc.provideContext({tools:tools});}
}catch(e){}
})();`;
}

/** Nothing rendered, nothing visible — one script, hoisted with the page. */
export function WebMcpTools({ owner, slug }: Props) {
  return <script dangerouslySetInnerHTML={{ __html: webMcpScript(owner, slug) }} />;
}
