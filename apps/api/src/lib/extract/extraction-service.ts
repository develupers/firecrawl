import { Document, ExtractRequest, URLTrace } from "../../controllers/v1/types";
import { PlanType } from "../../types";
import { logger } from "../logger";
import { processUrl } from "./url-processor";
import { scrapeDocument } from "./document-scraper";
import { generateOpenAICompletions } from "../../scraper/scrapeURL/transformers/llmExtract";
import { buildDocument } from "./build-document";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";

interface ExtractServiceOptions {
  request: ExtractRequest;
  teamId: string;
  plan: PlanType;
  subId?: string;
}

interface ExtractResult {
  success: boolean;
  data?: any;
  scrapeId: string;
  warning?: string;
  urlTrace?: URLTrace[];
  error?: string;
}

export async function performExtraction(options: ExtractServiceOptions): Promise<ExtractResult> {
  const { request, teamId, plan, subId } = options;
  const scrapeId = crypto.randomUUID();
  const urlTraces: URLTrace[] = [];
  let docs: Document[] = [];

  // Process URLs
  const urlPromises = request.urls.map(url => 
    processUrl({
      url,
      prompt: request.prompt,
      teamId,
      plan,
      allowExternalLinks: request.allowExternalLinks,
      origin: request.origin,
      limit: request.limit,
      includeSubdomains: request.includeSubdomains,
    }, urlTraces)
  );

  const processedUrls = await Promise.all(urlPromises);
  const links = processedUrls.flat().filter(url => url);

  if (links.length === 0) {
    return {
      success: false,
      error: "No valid URLs found to scrape. Try adjusting your search criteria or including more URLs.",
      scrapeId,
      urlTrace: urlTraces,
    };
  }

  // Scrape documents
  const timeout = Math.floor((request.timeout || 40000) * 0.7) || 30000;
  const scrapePromises = links.map(url =>
    scrapeDocument({
      url,
      teamId,
      plan,
      origin: request.origin || "api",
      timeout,
    }, urlTraces)
  );

  try {
    const results = await Promise.all(scrapePromises);
    docs.push(...results.filter((doc): doc is Document => doc !== null));
  } catch (error) {
    return {
      success: false,
      error: error.message,
      scrapeId,
      urlTrace: urlTraces,
    };
  }

  // Generate completions
  const completions = await generateOpenAICompletions(
    logger.child({ method: "extractService/generateOpenAICompletions" }),
    {
      mode: "llm",
      systemPrompt:
        (request.systemPrompt ? `${request.systemPrompt}\n` : "") +
        "Always prioritize using the provided content to answer the question. Do not make up an answer. Be concise and follow the schema always if provided. Here are the urls the user provided of which he wants to extract information from: " +
        links.join(", "),
      prompt: request.prompt,
      schema: request.schema,
    },
    docs.map((x) => buildDocument(x)).join("\n"),
    undefined,
    true,
  );

  // Update token usage in traces
  if (completions.numTokens) {
    const totalLength = docs.reduce((sum, doc) => sum + (doc.markdown?.length || 0), 0);
    docs.forEach((doc) => {
      if (doc.metadata?.sourceURL) {
        const trace = urlTraces.find((t) => t.url === doc.metadata.sourceURL);
        if (trace && trace.contentStats) {
          trace.contentStats.tokensUsed = Math.floor(
            ((doc.markdown?.length || 0) / totalLength) * completions.numTokens
          );
        }
      }
    });
  }

  // Bill team for usage
  billTeam(teamId, subId, links.length * 5).catch((error) => {
    logger.error(
      `Failed to bill team ${teamId} for ${links.length * 5} credits: ${error}`,
    );
  });

  // Log job
  logJob({
    job_id: scrapeId,
    success: true,
    message: "Extract completed",
    num_docs: 1,
    docs: completions.extract ?? {},
    time_taken: (new Date().getTime() - Date.now()) / 1000,
    team_id: teamId,
    mode: "extract",
    url: request.urls.join(", "),
    scrapeOptions: request,
    origin: request.origin ?? "api",
    num_tokens: completions.numTokens ?? 0,
  });

  return {
    success: true,
    data: completions.extract ?? {},
    scrapeId,
    warning: completions.warning,
    urlTrace: request.urlTrace ? urlTraces : undefined,
  };
} 