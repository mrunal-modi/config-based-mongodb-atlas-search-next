// Search functionality
// /src/app/api/documents/search/route.ts

// GET: Retrieves paginated search results
// service: searchDocuments

import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/dbConnect';
import { authMiddleware } from '@/lib/authMiddleware';
import { generateSearchPipeline } from '@/lib/generateSearchPipeline';
import searchConfigs, { ConfigType } from '@/config/searchConfigs';

// Type guard function to check if a string is a valid ConfigType
function isValidConfigType(configType: string): configType is ConfigType {
  return Object.keys(searchConfigs).includes(configType);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);
  const configType = searchParams.get('configType');
  const publicOnly = searchParams.get('publicOnly') === 'true';

  console.log('Search request:', { query, page, pageSize, configType, publicOnly });

  if (!query || !configType) {
    return NextResponse.json({ error: 'Query and configType are required' }, { status: 400 });
  }

  if (!isValidConfigType(configType)) {
    return NextResponse.json({ error: `Invalid configType: ${configType}` }, { status: 400 });
  }

  const config = searchConfigs[configType];

  try {
    const { db } = await dbConnect(config.database);
    console.log(`Connected to database: ${config.database}`);

    let userId: string | undefined;
    if (!publicOnly) {
      try {
        const authResponse = await authMiddleware(request);
        if (authResponse.status !== 401) {
          userId = (request as any).userId;
          console.log('User authenticated:', userId);
        }
      } catch (error) {
        console.log('Auth failed, searching only public documents');
      }
    }

    const validPage = Math.max(1, page);
    const validPageSize = Math.min(Math.max(1, pageSize), config.maxPageSize);

    const searchStages = generateSearchPipeline(config.indexDefinition, query);
    console.log('Generated search stages:', searchStages);

    if (searchStages.length === 0) {
      console.log('No search stages generated');
      return NextResponse.json({
        results: [],
        totalCount: 0,
        currentPage: validPage,
        totalPages: 0,
        pageSize: validPageSize
      });
    }

    const pipeline = [
      {
        $search: {
          index: config.index,
          compound: {
            should: searchStages
          }
        }
      },
      {
        $match: userId ? { $or: [{ userId: userId }, { isPublic: true }] } : { isPublic: true }
      },
      {
        $facet: {
          results: [
            { $skip: (validPage - 1) * validPageSize },
            { $limit: validPageSize },
            {
              $project: {
                _id: 1,
                userId: 1,
                userEmail: 1,
                isPublic: 1,
                ...Object.fromEntries(config.searchResultsSummaryFields.map((field: string) => [field, 1])),
                score: { $meta: 'searchScore' }
              }
            }
          ],
          totalCount: [{ $count: 'count' }]
        }
      },
      {
        $project: {
          results: 1,
          totalCount: { $arrayElemAt: ['$totalCount.count', 0] }
        }
      }
    ];

    console.log('Executing pipeline:', JSON.stringify(pipeline, null, 2));

    const result = await db.collection(config.collection).aggregate(pipeline).toArray();
    console.log('Aggregation result:', result);

    if (result && result.length > 0 && result[0].totalCount > 0) {
      const { results, totalCount } = result[0];
      const totalPages = Math.ceil(totalCount / validPageSize);

      console.log('Returning results:', { totalCount, currentPage: validPage, totalPages, pageSize: validPageSize });

      return NextResponse.json({
        results,
        totalCount,
        currentPage: validPage,
        totalPages,
        pageSize: validPageSize
      });
    } else {
      console.log('No results found');
      return NextResponse.json({
        results: [],
        totalCount: 0,
        currentPage: validPage,
        totalPages: 0,
        pageSize: validPageSize
      });
    }
  } catch (error: any) {
    console.error(`Search error:`, error);
    return NextResponse.json({
      error: "Error performing search",
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}