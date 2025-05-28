const {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} = require("@aws-sdk/client-bedrock-agent-runtime");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require("fs");
const path = require("path");

const AWS_REGION = "us-west-2";
const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const KNOWLEDGE_BASE_ID = "ZEVRTT7CCF"; // Default Knowledge Base ID

const S3_BUCKET_NAME = "closedaioutput"; // Replace with your actual S3 bucket name

const queryKnowledgeBase = async (requestData) => {
  // Extract parameters from request data with defaults
  // {repository: $repo, pr_number: $pr_number, diff: }
  const {
    repository,
    pr_number,
    repositoryUrl,
    commitSha,
    diff,
    branch,
    pr_description,
    knowledgeBaseId = KNOWLEDGE_BASE_ID,
    modelId = MODEL_ID,
    numberOfResults = 5,
    searchType = "HYBRID",
    maxTokens = 1000,
    temperature = 0.7,
    topP = 0.9,
    includeMetadata = true,
  } = requestData;

  const s3Prefix = repository;

  const query = `
  You are a QA automation assistant specialized in mobile app testing. Given the Git diff and PR description, your task is to generate detailed, step-by-step manual test cases in a structured and human-readable format suitable for mobile-mcp.

Follow this structure and behavior:

App: Always include the package identifier, e.g., App: com.qazi9amaan.rntodoapp.

Test: Provide a concise but descriptive title of the test scenario (e.g., "Bug Fix Verification - Duplicate Todo Item Creation").

Write each action and validation step as a clear, user-driven instruction.
Include logical pauses like "Wait for screen to load" where needed.
Include validation steps like counting elements, verifying text, checking visibility, etc.
Use screenshots strategically to capture UI state before and after critical actions.
Ensure the test case covers both the happy path and basic edge cases relevant to the code change.
Use the PR title, description, and code diff to infer what functionality has changed or been added. Then generate a test scenario that verifies this change thoroughly.

Here's an example of your expected output format:
App: com.qazi9amaan.rntodoapp  
Test: Bug Fix Verification - Duplicate Todo Item Creation  

Launch the todo app  
Wait for the main screen to load  
Count the current number of todo items  
Take a screenshot of the initial state  
Tap on the add task input field  
Type 'Test task for bug verification'  
Tap the add button  
Wait for the task to be added  
Count the number of todo items again  
Verify that exactly 1 new item was added  
Verify the new task shows 'Test task for bug verification'  
Take a screenshot showing the single new item  
Clear the input field  
Type 'Second test task'  
Tap the add button  
Wait for the task to be added  
Count the total number of todo items  
Verify that exactly 1 more item was added  
Verify both tasks are visible in the list  
Take a screenshot of the final state  
Mark the first task as completed  
Verify only the first task shows as completed  
Delete the second task  
Verify the task is removed from the list  
Take a final screenshot  
Now, based on the following PR description and code diff, generate a test case in this exact format with minimum 20 test cases.

[PR Title]
${repository}

[PR Description]
${pr_description}

[Git Diff]
${diff}
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

    // Create a timestamp for unique file naming
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `testcases-${pr_number}-${timestamp}.txt`;
    const filePath = `/tmp/${fileName}`; // Use /tmp directory in Lambda

    // Prepare file content with metadata
    const fileContent = generatedText;

    // Write the response to a local file
    fs.writeFileSync(filePath, fileContent, "utf8");
    console.log(`Response written to local file: ${filePath}`);

    // Upload file to S3
    const s3Key = `${s3Prefix}/${fileName}`;
    const uploadParams = {
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: fs.readFileSync(filePath),
      ContentType: "text/plain",
      Metadata: {
        "knowledge-base-id": knowledgeBaseId,
        "model-id": modelId,
        "session-id": apiResponse.sessionId || "none",
        "search-type": searchType,
        timestamp: timestamp,
      },
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // Generate a pre-signed URL for the uploaded file (valid for 1 hour)
    const presignedUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
      }),
      { expiresIn: 86400 }
    );

    // Clean up local file
    fs.unlinkSync(filePath);
    console.log(`Local file cleaned up: ${filePath}`);

    return {
      appPackage: "com.qazi9amaan.rntodoapp",
      testName: `Test for PR ${pr_number}`,
      testInstructionsUrl: presignedUrl,
      priority: "high",
      timeout: 180,
      metadata: {
        jiraTicketId: "PROJ-1234",
        commitSha: commitSha,
        repositoryUrl: repositoryUrl,
        prNumber: pr_number,
        branch: branch,
      },
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
      body: result,
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
