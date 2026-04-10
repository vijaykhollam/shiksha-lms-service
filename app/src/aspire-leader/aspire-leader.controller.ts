import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Query,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { AspireLeaderService } from './aspire-leader.service';
import { CourseReportDto, CourseReportHeadersDto } from './dto/course-report.dto';
import { LessonCompletionStatusDto, LessonCompletionStatusResponseDto } from './dto/lesson-completion-status.dto';
import { UpdateTestProgressDto } from './dto/update-test-progress.dto';
import { AggregationDto, AggregatedResponseDto, AggregationHeadersDto } from './dto/aggregation.dto';
import { TrackingStatus } from '../tracking/entities/course-track.entity';
import { EnrollmentStatus } from '../enrollments/entities/user-enrollment.entity';
import { API_IDS } from '../common/constants/api-ids.constant';
import { ApiId } from '../common/decorators/api-id.decorator';
import { TenantOrg } from '../common/decorators/tenant-org.decorator';
import { ParseBoolPipe } from '@nestjs/common';

@ApiTags('Aspire Leader Reports')
@Controller('course')
export class AspireLeaderController {
  constructor(
    private readonly aspireLeaderService: AspireLeaderService,
  ) { }

  @Get('report')
  @ApiId(API_IDS.GET_COURSE_REPORT)
  @ApiOperation({
    summary: 'Generate course report',
    description: 'Generate course-level or lesson-level reports with user progress and activity data. Include lessonId for lesson-level report, omit for course-level report. Requires Authorization header for external API calls.'
  })
  @ApiQuery({ name: 'courseId', type: 'string', description: 'Target course ID', required: true })
  @ApiQuery({ name: 'cohortId', type: 'string', description: 'Associated cohort ID (optional for pathway-only exports)', required: false })
  @ApiQuery({ name: 'pathwayId', type: 'string', description: 'Pathway ID when export is pathway-scoped', required: false })
  @ApiQuery({ name: 'lessonId', type: 'string', description: 'Required only for content-level report', required: false })
  @ApiQuery({ name: 'offset', type: 'number', description: 'For pagination (default: 0)', required: false })
  @ApiQuery({ name: 'limit', type: 'number', description: 'For pagination (default: 10)', required: false })
  @ApiQuery({ name: 'sortBy', type: 'string', description: 'Field to sort by (e.g., progress)', required: false })
  @ApiQuery({ name: 'orderBy', type: 'string', enum: ['asc', 'desc'], description: 'Sort order', required: false })
  @ApiQuery({ name: 'status', type: 'string', enum: Object.values(TrackingStatus), description: 'Filter by course tracking status', required: false })
  @ApiQuery({ name: 'enrollmentStatus', type: 'string', enum: Object.values(EnrollmentStatus), description: 'Filter by enrollment status', required: false })
  @ApiQuery({ name: 'certificateIssued', type: 'boolean', description: 'Filter by certificate issued status', required: false })
  @ApiResponse({
    status: 200,
    description: 'Course report generated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid parameters or missing Authorization header' })
  @ApiResponse({ status: 404, description: 'Course or lesson not found' })
  async generateCourseReport(
    @Query() reportDto: CourseReportDto,
    @Query('certificateIssued', new ParseBoolPipe({ optional: true })) certificateIssued: boolean,
    @TenantOrg() tenantOrg: { tenantId: string; organisationId: string },
    @Headers() headers: CourseReportHeadersDto,
  ): Promise<any> {
    reportDto.certificateIssued = certificateIssued;
    return this.aspireLeaderService.generateCourseReport(
      reportDto,
      tenantOrg.tenantId,
      tenantOrg.organisationId,
      headers.authorization,
    );
  }

  // thie api will accept the cohortId and criteria will be json array like lessonFormat, lessonSubFormat and completionRule (0 , 1, 2, 3 - n)
  // this api will 1st check if the cohortId is valid and find the all the published lessons as per the format -subformat and minimum completed lesosn as per completionRule
  // and return the response as per the criteria - true or false
  @Post('lesson-completion-status')
  @ApiId(API_IDS.GET_LESSON_COMPLETION_STATUS)
  @ApiOperation({
    summary: 'Check lesson completion status for cohort',
    description: 'Check if a cohort meets the lesson completion criteria based on lesson format, sub-format, and minimum completion requirements. The cohortId should match the value stored in course.params.cohortId. Returns overall status and detailed results for each criterion.'
  })
  @ApiResponse({
    status: 200,
    description: 'Lesson completion status checked successfully',
    type: LessonCompletionStatusResponseDto
  })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid parameters or cohort not found' })
  @ApiResponse({ status: 404, description: 'Cohort not found' })
  async checkLessonCompletionStatus(
    @Body() completionDto: LessonCompletionStatusDto,
    @TenantOrg() tenantOrg: { tenantId: string; organisationId: string },
  ): Promise<LessonCompletionStatusResponseDto> {
    return this.aspireLeaderService.checkLessonCompletionStatus(
      completionDto,
      tenantOrg.tenantId,
      tenantOrg.organisationId,
    );
  }
  @Post('aggregate-content')
  @ApiId(API_IDS.GET_AGGREGATED_CONTENT)
  @ApiOperation({
    summary: 'Get nested aggregated content for a cohort',
    description: 'Returns courses (labeled as modules), modules (labeled as units), and lessons (labeled as contents) for a specific cohort. Can be filtered by contentType (e.g., "event").'
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregated content retrieved successfully',
    type: AggregatedResponseDto
  })
async getAggregatedContent(
  @Body() aggregationDto: AggregationDto,
  @TenantOrg() tenantOrg: { tenantId: string; organisationId: string },
  @Headers() headers: AggregationHeadersDto,
): Promise<any> {
  return this.aspireLeaderService.getAggregatedContent(
    aggregationDto.cohortId,
    tenantOrg.tenantId,
    tenantOrg.organisationId,
    headers.authorization,
    aggregationDto.contentType,
    aggregationDto.pathwayId,
    aggregationDto.userId,
  );
}


  @Patch('tracking/update_test_progress')
  @ApiId(API_IDS.UPDATE_TEST_PROGRESS)
  @ApiOperation({
    summary: 'Update test progress for a lesson',
    description: 'Update lesson tracking progress based on test results. The testId maps to media.source column, which is linked to lesson.mediaId. The system will find the correct lesson track based on resubmission settings and grading type.'
  })
  @ApiResponse({
    status: 200,
    description: 'Test progress updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid parameters' })
  @ApiResponse({ status: 404, description: 'Test, lesson, or lesson tracking not found' })
  async updateTestProgress(
    @Body() updateTestProgressDto: UpdateTestProgressDto,
    @TenantOrg() tenantOrg: { tenantId: string; organisationId: string },
  ): Promise<any> {
    return this.aspireLeaderService.updateTestProgress(
      updateTestProgressDto,
      tenantOrg.tenantId,
      tenantOrg.organisationId,
    );
  }
} 