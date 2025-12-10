import { NextRequest, NextResponse } from 'next/server';
import { getIndexes } from '@/lib/pinecone';
import openai from '@/lib/openai';

interface Document {
  id: string;
  content: string;
  metadata: {
    id: string;
    name: string;
    year: string;
    [key: string]: any;
  };
}



// Get embeddings from OpenAI
async function getEmbedding(text: string) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text,
  });
  return response.data[0].embedding;
}

// AI-powered query expansion
async function expandQuery(question: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a search query optimizer for Aaltoes (Aalto Entrepreneurship Society) document database.
Your task is to expand the user's search query to improve document retrieval.

Rules:
- Add relevant synonyms and related terms
- Include both formal and informal variations
- Add Finnish equivalents if relevant (Aaltoes is based in Finland)
- Keep the expanded query concise (max 100 words)
- Focus on business, entrepreneurship, and organizational terms
- Return ONLY the expanded query, no explanations

Example:
Input: "budget 2024"
Output: "budget 2024 finances financial plan spending expenses costs allocation money funding annual budget yearly budget talousarvio"`
        },
        {
          role: 'user',
          content: question
        }
      ],
      max_tokens: 150,
      temperature: 0.3,
    });

    const expandedQuery = response.choices[0]?.message?.content?.trim();
    if (expandedQuery) {
      console.log('Query expanded:', question, '->', expandedQuery);
      return expandedQuery;
    }
    return question;
  } catch (error) {
    console.error('Query expansion failed, using original:', error);
    return question;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question, selectedYears, selectedDataTypes, topK } = await request.json();
    // Always use private indexes for now (public indexes not available)
    const isPrivate = true;
    
    if (!question) {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    // Step 1: Use selected years from UI (no automatic extraction)
    const years = selectedYears || [];
    const searchTopK = topK || 50; // Default to 50 if not provided
    console.log('Selected years from UI:', years);
    console.log('TopK from UI:', searchTopK);
    
    // Step 2: Check if question is related to Aaltoes (more inclusive approach)
    const business_context_keywords = [
      'aaltoes', 'aalto', 'entrepreneurship', 'entrepreneur', 'startup', 'business', 
      'innovation', 'venture', 'company', 'founder', 'team', 'project', 'case',
      'strategy', 'market', 'product', 'service', 'customer', 'revenue', 'growth',
      'leadership', 'management', 'organization', 'community', 'network', 'event',
      'program', 'initiative', 'development', 'success', 'challenge', 'solution',
      'impact', 'ecosystem', 'culture', 'values', 'mission', 'vision', 'goal',
      'board', 'budget', 'decision', 'meeting', 'society', 'member', 'activity'
    ];
    
    // Clearly unrelated topics that should be filtered out
    const unrelated_keywords = [
      'weather', 'sports', 'cooking', 'recipe', 'movie', 'music', 'game', 
      'celebrity', 'politics', 'religion', 'medicine', 'health', 'personal',
      'travel', 'vacation', 'hobby', 'entertainment', 'fashion', 'shopping'
    ];
    
    const lowerQuestion = question.toLowerCase();
    const hasBusinessContext = business_context_keywords.some(keyword => lowerQuestion.includes(keyword));
    const hasUnrelatedContent = unrelated_keywords.some(keyword => lowerQuestion.includes(keyword));
    const questionWords = lowerQuestion.split(/\s+/).filter((word: string) => word.length > 2);
    const isReasonableLength = questionWords.length >= 2;
    
    // More inclusive: allow if it has business context OR if it's not clearly unrelated and reasonable length
    const isRelatedToAaltoes = (hasBusinessContext || (!hasUnrelatedContent && isReasonableLength));
    
    // Step 3: Preprocess question (replace aaltoes with Aaltoes)
    const processedQuestion = question.replace(/\baaltoes\b/gi, 'Aaltoes');
    
    // Step 4: Only search if question is related to Aaltoes
    let documents: Array<{id: string; name: string; year: string; score: number; numQuestions: number; link: string | null}> = [];
    let allChunks: Document[] = [];
    let summaryResults: any = null;
    
    if (isRelatedToAaltoes) {
      // Step 4a: Get appropriate indexes based on private access
      const { summaryIndex, chunkIndex, questionsIndex } = getIndexes(isPrivate);
      console.log('Using indexes for private access:', isPrivate);
      
      // Step 4b: Get embedding for the question
      const questionEmbedding = await getEmbedding(processedQuestion);
      
      // Step 4c: Search both summaries and questions indexes for comprehensive results
      console.log('Searching summaries and questions indexes');
      
      // Build filters for metadata queries
      const dataTypes = selectedDataTypes || [];
      const yearFilter = years.length > 0 ? { year: { $in: years } } : undefined;
      
      console.log('Selected data types:', dataTypes);
      console.log('Year filter:', yearFilter);
      
      // Build data type filter
      let dataTypeFilter = undefined;
      if (dataTypes.length > 0 && !dataTypes.includes('all')) {
        if (dataTypes.includes('documents') && dataTypes.includes('excel')) {
          // Both selected - no filter needed
          dataTypeFilter = undefined;
          console.log('Both documents and excel selected - no filter');
        } else if (dataTypes.includes('documents')) {
          dataTypeFilter = { 
            $and: [
              { mimeType: { $ne: 'application/vnd.google-apps.spreadsheet' } },
              { mimeType: { $ne: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }
            ]
          };
          console.log('Documents only filter:', dataTypeFilter);
        } else if (dataTypes.includes('excel')) {
          dataTypeFilter = { 
            $or: [
              { mimeType: 'application/vnd.google-apps.spreadsheet' },
              { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            ]
          };
          console.log('Excel only filter:', dataTypeFilter);
        }
      } else {
        console.log('No data type filtering (all or empty)');
      }
      
      // Combine filters
      const combinedFilter = (() => {
        if (yearFilter && dataTypeFilter) {
          return { $and: [yearFilter, dataTypeFilter] };
        } else if (yearFilter) {
          return yearFilter;
        } else if (dataTypeFilter) {
          return dataTypeFilter;
        } else {
          return undefined;
        }
      })();
      
      console.log('Combined filter for Pinecone query:', JSON.stringify(combinedFilter, null, 2));

      const [summaryResults, questionResults] = await Promise.all([
        // Search summaries with combined filter
        summaryIndex.query({
          vector: questionEmbedding,
          topK: searchTopK,
          includeMetadata: true,
          filter: combinedFilter,
        }).catch(error => {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        }),
        // Search questions with combined filter
        questionsIndex.query({
          vector: questionEmbedding,
          topK: searchTopK,
          includeMetadata: true,
          filter: combinedFilter,
        }).catch(error => {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        })
      ]);

      console.log('Summary results count:', summaryResults.matches?.length);
      console.log('Question results count:', questionResults.matches?.length);
      
      // Debug: Show some example results to verify filter is working
      if (summaryResults.matches?.length > 0) {
        console.log('Sample summary results:');
        summaryResults.matches.slice(0, 3).forEach((match: any, i: number) => {
          console.log(`  ${i+1}. ${match.metadata?.name} - mimeType: ${match.metadata?.mimeType}`);
        });
      }
      
      if (questionResults.matches?.length > 0) {
        console.log('Sample question results:');
        questionResults.matches.slice(0, 3).forEach((match: any, i: number) => {
          console.log(`  ${i+1}. ${match.metadata?.name} - mimeType: ${match.metadata?.mimeType}`);
        });
      }

      // Step 5: Create hybrid document ranking combining summaries and questions
      const processedSummaries = summaryResults.matches || [];
      const processedQuestions = questionResults.matches || [];

      // Create hybrid scoring: combine summary similarity with question relevance
      const documentScores = new Map<string, {summary: number, question: number, metadata: any}>();

      // Add summary scores (summaries use "id" field)
      console.log('Processing summaries:', processedSummaries.length);
      processedSummaries.forEach((match: any, index: number) => {
        const docId = match.metadata?.id; // Summaries use "id"
        console.log(`Summary ${index}: docId=${docId}, name=${match.metadata?.name}, score=${match.score}`);
        if (docId) {
          documentScores.set(docId, {
            summary: match.score || 0,
            question: 0,
            metadata: match.metadata
          });
        }
      });

      // Add question scores (questions use "doc_id" field)
      console.log('Processing questions:', processedQuestions.length);
      processedQuestions.forEach((match: any, index: number) => {
        const docId = match.metadata?.doc_id; // Questions use "doc_id"
        console.log(`Question ${index}: docId=${docId}, name=${match.metadata?.name}, score=${match.score}`);
        if (docId && documentScores.has(docId)) {
          const existing = documentScores.get(docId)!;
          existing.question = match.score || 0;
          console.log(`Enhanced existing doc ${docId} with question score ${match.score}`);
        } else if (docId) {
          documentScores.set(docId, {
            summary: 0,
            question: match.score || 0,
            metadata: match.metadata
          });
          console.log(`Added new doc ${docId} from questions only`);
        }
      });

      console.log('Total unique documents after combining:', documentScores.size);

      // Calculate hybrid scores (weighted combination)
      const hybridDocuments = Array.from(documentScores.entries()).map(([docId, scores]) => ({
        docId,
        summaryScore: scores.summary,
        questionScore: scores.question,
        // Hybrid score: 30% summary + 70% question similarity
        hybridScore: (scores.summary * 0.3) + (scores.question * 0.7),
        metadata: scores.metadata
      })).sort((a, b) => b.hybridScore - a.hybridScore).slice(0, searchTopK);

      console.log('Top hybrid documents:', 
        hybridDocuments.slice(0, 5).map((doc: any) => ({
          name: doc.metadata?.name,
          summaryScore: doc.summaryScore.toFixed(3),
          questionScore: doc.questionScore.toFixed(3),
          hybridScore: doc.hybridScore.toFixed(3),
          year: doc.metadata?.year
        }))
      );

      // Get document IDs from hybrid ranking
      let docIds = hybridDocuments.map(doc => doc.docId);

      // Fallback: if hybrid approach yields no results, use summaries directly
      if (docIds.length === 0 && processedSummaries.length > 0) {
        console.log('Hybrid approach yielded no results, falling back to summaries only');
        docIds = processedSummaries.map((match: any) => match.metadata?.id).filter(Boolean); // Summaries use "id"
      }

      console.log('Processing documents from hybrid/summaries:', docIds.length);

      // Step 6: Search chunks for each document - 1 chunk per document for diversity
      const maxChunksPerDoc = 1; // Changed from 10 to 1 for maximum document diversity
      
      console.log(`Getting chunks for ${docIds.length} documents`);
      
      for (const docId of docIds) {
        console.log(`Searching chunks for document: ${docId}`);
        
        // Search chunks (chunks use "id" field)
        let chunkResults;
        try {
          // Apply combined filter to chunks as well
          const chunkFilter = combinedFilter ? { ...combinedFilter, id: docId } : { id: docId };
          chunkResults = await chunkIndex.query({
            vector: questionEmbedding,
            topK: 1, // Only get 1 chunk per document
            includeMetadata: true,
            filter: chunkFilter,
          });
        } catch (error: any) {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        }
        
        console.log(`Chunk results for ${docId}:`, chunkResults.matches?.length || 0);
        
        // If still no results, try without any filter to get relevant chunks
        if (!chunkResults.matches?.length) {
          console.log(`No chunks found with filters for ${docId}, trying semantic search without filter`);
          try {
            // Apply combined filter even in fallback semantic search
            chunkResults = await chunkIndex.query({
              vector: questionEmbedding,
              topK: 1, // Only get 1 chunk per document
              includeMetadata: true,
              filter: combinedFilter, // Apply combined filter for semantic search too
            });
          } catch (error: any) {
            if (error.message?.includes('404') || error.message?.includes('not found')) {
              if (isPrivate) {
                throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
              } else {
                throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
              }
            }
            throw error;
          }
          
          // Filter the results to only include chunks that might be from our target documents
          if (chunkResults.matches?.length) {
            const filteredMatches = chunkResults.matches.filter(match => {
              const chunkDocId = match.metadata?.doc_id || match.metadata?.id;
              const chunkName = match.metadata?.name;
              const chunkYear = String(match.metadata?.year || '');
              
              // Check if this chunk belongs to any of our target documents
              const belongsToTargetDoc = docIds.some(targetDocId => 
                chunkDocId === targetDocId || 
                documents.some(doc => doc.name === chunkName)
              );
              
              // If years are specified, also check if chunk is from the right year
              if (years.length > 0) {
                const isFromCorrectYear = years.includes(chunkYear) || years.includes(String(parseInt(chunkYear)));
                return belongsToTargetDoc && isFromCorrectYear;
              }
              
              return belongsToTargetDoc;
            });
            
            if (filteredMatches.length > 0) {
              chunkResults.matches = filteredMatches.slice(0, 1); // Only take 1 chunk
              console.log(`Found ${filteredMatches.length} chunks via semantic search for document-related content`);
            }
          }
        }
        
        console.log(`Final chunk results for ${docId}:`, chunkResults.matches?.length || 0);
        
        const chunks = chunkResults.matches?.map(match => ({
          id: match.id || '',
          content: String(match.metadata?.text || ''),
          score: match.score || 0,
          metadata: {
            id: String(match.metadata?.doc_id || match.metadata?.id || ''),
            name: String(match.metadata?.name || 'Untitled'),
            year: String(match.metadata?.year || 'unknown'),
            link: match.metadata?.url || 
                  match.metadata?.google_drive_link || 
                  match.metadata?.drive_link || 
                  match.metadata?.link || 
                  null,
            ...match.metadata,
          }
        })).filter(chunk => chunk.content)
          .sort((a, b) => b.score - a.score) // Sort by relevance score
          .slice(0, 1) || []; // Take only the best chunk from this document
        
        console.log(`Processed chunks for ${docId}:`, chunks.length);
        allChunks.push(...chunks);
      }

      console.log('Total chunks collected:', allChunks.length);

      // Step 8: Final diversification - ensure we have chunks from multiple documents
      const chunksByDocument = allChunks.reduce((acc, chunk) => {
        const docId = chunk.metadata.id;
        if (!acc[docId]) acc[docId] = [];
        acc[docId].push(chunk);
        return acc;
      }, {} as Record<string, typeof allChunks>);

      // Interleave chunks from different documents to ensure diversity
      const diversifiedChunks = [];
      const documentIds = Object.keys(chunksByDocument);
      let maxRounds = Math.max(...Object.values(chunksByDocument).map(chunks => chunks.length));
      
      for (let round = 0; round < maxRounds && diversifiedChunks.length < searchTopK; round++) {
        for (const docId of documentIds) {
          if (chunksByDocument[docId][round] && diversifiedChunks.length < searchTopK) {
            diversifiedChunks.push(chunksByDocument[docId][round]);
          }
        }
      }

      allChunks = diversifiedChunks;
      
      console.log('Chunks distribution:', 
        Object.entries(chunksByDocument).map(([docId, chunks]) => ({
          document: chunks[0]?.metadata.name || docId,
          chunkCount: chunks.length,
          scores: chunks.map((c: any) => c.score.toFixed(3))
        }))
      );

      // Step 7: Prepare response data using hybrid-ranked documents or fallback to summaries
      let documentsBeforeYearFilter: any[] = [];
      
      if (hybridDocuments.length > 0) {
        // Use hybrid results
        documentsBeforeYearFilter = hybridDocuments.map((hybridDoc: any) => ({
          id: hybridDoc.docId || '',
          name: hybridDoc.metadata?.name || 'Untitled',
          year: hybridDoc.metadata?.year ? String(hybridDoc.metadata.year) : 'unknown',
          score: hybridDoc.hybridScore || 0, // Hybrid similarity score
          summaryScore: hybridDoc.summaryScore || 0,
          questionScore: hybridDoc.questionScore || 0,
          numQuestions: hybridDoc.metadata?.num_questions || 0,
          // Extract links from new structure
          link: hybridDoc.metadata?.url || 
                hybridDoc.metadata?.google_drive_link || 
                hybridDoc.metadata?.drive_link || 
                hybridDoc.metadata?.link || 
                null,
        }));
      } else if (processedSummaries.length > 0) {
        // Fallback to summaries only
        console.log('Using summaries fallback for document preparation');
        documentsBeforeYearFilter = processedSummaries.map((match: any) => ({
          id: match.metadata?.id || '', // Summaries use "id"
          name: match.metadata?.name || 'Untitled',
          year: match.metadata?.year ? String(match.metadata.year) : 'unknown',
          score: match.score || 0, // Summary similarity score
          summaryScore: match.score || 0,
          questionScore: 0,
          numQuestions: match.metadata?.num_questions || 0,
          // Extract links from new structure
          link: match.metadata?.url || 
                match.metadata?.google_drive_link || 
                match.metadata?.drive_link || 
                match.metadata?.link || 
                null,
        }));
      }

      console.log('Documents before year filtering:', documentsBeforeYearFilter.map((d: any) => ({ 
        name: d.name, 
        year: d.year, 
        score: d.score.toFixed(3) 
      })));

      // Year filtering already applied at Pinecone query level
      documents = documentsBeforeYearFilter;
      console.log('Documents after Pinecone year filtering:', documents.length);

      console.log('Documents with question similarity:', documents.map(d => ({ 
        name: d.name, 
        year: d.year, 
        score: d.score,
        numQuestions: d.numQuestions,
        hasLink: !!d.link 
      })));
    } else {
      console.log('Question not related to Aaltoes, skipping document search');
      // Return early with empty results for unrelated questions
      return NextResponse.json({
        years: [],
        documents: [],
        chunks: [],
        question: processedQuestion,
        isRelated: false,
      });
    }

    // Step 9: Get only unique sources from chunks (documents actually used) and sort by question similarity
    const usedDocuments = documents.length > 0 ? Array.from(new Set(
      allChunks.map(chunk => chunk.metadata.id)
    )).map(docId => {
      // Find the question-matched document that matches this chunk's document ID
      const questionDoc = documents.find(doc => doc.id === docId);
      return questionDoc ? {
        id: String(questionDoc.id || ''),
        name: String(questionDoc.name || 'Untitled'),
        year: String(questionDoc.year || 'unknown'),
        score: questionDoc.score || 0, // Use question similarity score
        numQuestions: questionDoc.numQuestions || 0,
        link: questionDoc.link,
      } : null;
    }).filter(Boolean)
      .sort((a: any, b: any) => (b?.score || 0) - (a?.score || 0)) : []; // Sort by question similarity score

    // Step 10: Filter chunks to only include those from documents that will be displayed
    const displayedDocumentIds = new Set(usedDocuments.map(doc => doc?.id));
    const filteredChunks = allChunks.filter(chunk => 
      displayedDocumentIds.has(chunk.metadata.id)
    );

    console.log('Used documents (displayed to user):', usedDocuments.map(d => ({ 
      name: d?.name, 
      year: d?.year, 
      score: d?.score,
      numQuestions: d?.numQuestions,
      hasLink: !!d?.link 
    })));

    console.log('Chunks sent to LLM:', filteredChunks.length, 'from', displayedDocumentIds.size, 'displayed documents');

    return NextResponse.json({
      years,
      documents: usedDocuments,
      chunks: filteredChunks, // Only chunks from displayed documents
      question: processedQuestion,
      isRelated: true,
    });

  } catch (error: any) {
    console.error('Search error:', error);
    
    // Check if this is our custom availability error (public or private)
    if (error.message?.includes('not implemented yet') || error.message?.includes('not available yet')) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
