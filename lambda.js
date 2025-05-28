const {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} = require("@aws-sdk/client-bedrock-agent-runtime");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const AWS_REGION = "us-west-2";
const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const KNOWLEDGE_BASE_ID = "ZEVRTT7CCF"; // Default Knowledge Base ID
const DEFAULT_PROMPT = "Hi. What does task manager do?";

// S3 Configuration
const S3_BUCKET_NAME = "closedaioutput"; // Replace with your actual S3 bucket name

const queryKnowledgeBase = async (requestData) => {
  // Extract parameters from request data with defaults
  // {repository: $repo, pr_number: $pr_number, diff: }
  const {
    repository,
    pr_number,
    diff,
    knowledgeBaseId = KNOWLEDGE_BASE_ID,
    modelId = MODEL_ID,
    numberOfResults = 5,
    searchType = "HYBRID",
    maxTokens = 1000,
    temperature = 0.7,
    topP = 0.9,
    includeMetadata = true,
  } = requestData;
  console.log("requestData ", requestData);
  const s3Prefix = repository;

  const query = `
  You are a helpful assistant that can answer questions about the codebase.
  You are given a repository, a pull request number, and a diff.
  You need to generate test cases that what can break because of these changes.
  this is the repository: ${repository}
  this is the diff: ${diff}
  `;

  // Create a new Bedrock Agent Runtime client instance.
  const client = new BedrockAgentRuntimeClient({ region: AWS_REGION });

  // Create S3 client instance
  const s3Client = new S3Client({ region: AWS_REGION });

  // Prepare the payload for the knowledge base query
  const payload = {
    input: {
      text: query,
    },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE",
      knowledgeBaseConfiguration: {
        knowledgeBaseId: knowledgeBaseId,
        modelArn: modelId,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: numberOfResults,
            overrideSearchType: searchType,
          },
        },
        generationConfiguration: {
          inferenceConfig: {
            textInferenceConfig: {
              maxTokens: maxTokens,
              temperature: temperature,
              topP: topP,
            },
          },
        },
      },
    },
  };

  try {
    // Query the knowledge base and generate response
    const apiResponse = await client.send(
      new RetrieveAndGenerateCommand(payload)
    );

    // Extract the generated response
    const generatedText = apiResponse.output.text;
    console.log(`Response generated successfully`);

    // Create a timestamp for unique file naming
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `bedrock-response-${timestamp}.txt`;
    const filePath = `/tmp/${fileName}`; // Use /tmp directory in Lambda

    // Prepare file content with metadata
    const fileContent = `
=== Bedrock Knowledge Base Response ===
Timestamp: ${new Date().toISOString()}
Knowledge Base ID: ${knowledgeBaseId}
Model: ${modelId}
Query: ${query}
Session ID: ${apiResponse.sessionId || "N/A"}
Search Type: ${searchType}
Number of Results: ${numberOfResults}
Temperature: ${temperature}
Max Tokens: ${maxTokens}
git diff: ${diff}
repository: ${repository}
pr_number: ${pr_number}

=== Generated Response ===
${generatedText}

=== Request Parameters ===
${includeMetadata ? JSON.stringify(requestData, null, 2) : "Metadata excluded"}

=== Additional Information ===
Response generated using AWS Bedrock Knowledge Base integration
Processed at: ${new Date().toISOString()}
`;

    // Write the response to a local file
    fs.writeFileSync(filePath, fileContent, "utf8");
    console.log(`Response written to local file: ${filePath}`);

    // Upload file to S3
    const s3Key = `${s3Prefix}/${pr_number}/${fileName}`;
    const uploadParams = {
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: fs.readFileSync(filePath),
      ContentType: "text/plain",
      Metadata: {
        "knowledge-base-id": knowledgeBaseId,
        "model-id": modelId,
        "session-id": apiResponse.sessionId || "none",
        "query-hash": Buffer.from(query).toString("base64").substring(0, 50),
        "search-type": searchType,
        timestamp: timestamp,
      },
    };

    const uploadResult = await s3Client.send(
      new PutObjectCommand(uploadParams)
    );
    console.log(`File uploaded to S3: s3://${S3_BUCKET_NAME}/${s3Key}`);
    console.log(`Upload ETag: ${uploadResult.ETag}`);

    // Clean up local file
    fs.unlinkSync(filePath);
    console.log(`Local file cleaned up: ${filePath}`);

    return {
      generatedText,
      s3Location: `s3://${S3_BUCKET_NAME}/${s3Key}`,
      sessionId: apiResponse.sessionId,
      fileName: fileName,
      query: query,
      knowledgeBaseId: knowledgeBaseId,
      modelId: modelId,
      requestParameters: requestData,
    };
  } catch (error) {
    console.error("Error querying knowledge base:", error);
    throw error;
  }
};

exports.handler = async function (event) {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Parse request data from different sources
    let requestData = {};

    // Handle different event sources (API Gateway, direct invocation, etc.)
    if (event.body) {
      // API Gateway POST request
      try {
        requestData =
          typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } catch (parseError) {
        console.error("Error parsing request body:", parseError);
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
          },
          body: JSON.stringify({
            error: "Invalid JSON in request body",
            details: parseError.message,
          }),
        };
      }
    }

    const result = await queryKnowledgeBase(requestData);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: JSON.stringify({
        message: "Knowledge base query completed successfully",
        s3Location: result.s3Location,
        fileName: result.fileName,
        sessionId: result.sessionId,
        query: result.query,
        knowledgeBaseId: result.knowledgeBaseId,
        modelId: result.modelId,
        responsePreview: result.generatedText.substring(0, 200) + "...",
        requestParameters: result.requestParameters,
      }),
    };
  } catch (error) {
    console.error("Lambda execution failed:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to query knowledge base",
        details: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
