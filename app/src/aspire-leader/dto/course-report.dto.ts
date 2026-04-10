import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsInt, IsString, Min, IsIn, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { TrackingStatus } from '../../tracking/entities/course-track.entity';
import { EnrollmentStatus } from '../../enrollments/entities/user-enrollment.entity';

export class CourseReportHeadersDto {
  @ApiProperty({
    description: 'Authentication token for external API calls',
    example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    type: 'string'
  })
  @IsString()
  authorization: string;
}

export class CourseReportDto {
  @ApiProperty({
    description: 'Target course ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
    type: 'string',
    format: 'uuid'
  })
  @IsUUID()
  courseId: string;

  @ApiProperty({
    description:
      'Associated cohort ID (optional). Report queries are scoped by courseId/lessonId; omit for pathway-driven exports that only send pathwayId elsewhere.',
    example: '123e4567-e89b-12d3-a456-426614174001',
    type: 'string',
    format: 'uuid',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiProperty({
    description:
      'Pathway ID when the export is pathway-scoped (optional; reserved for future cohort/pathway filtering).',
    example: '123e4567-e89b-12d3-a456-426614174003',
    type: 'string',
    format: 'uuid',
    required: false,
  })
@IsOptional()
  @IsUUID()
  pathwayId?: string;

  @ApiProperty({
    description: 'Required only for content-level report',
    example: '123e4567-e89b-12d3-a456-426614174002',
    type: 'string',
    format: 'uuid',
    required: false
  })
  @IsOptional()
  @IsUUID()
  lessonId?: string;

  @ApiProperty({
    description: 'Offset for pagination',
    example: 0,
    type: 'number',
    required: false,
    default: 0
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  @ApiProperty({
    description: 'Limit for pagination',
    example: 10,
    type: 'number',
    required: false,
    default: 10
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;

  @ApiProperty({
    description: 'Field to sort by',
    example: 'progress',
    type: 'string',
    required: false,
  })
  @IsOptional()
  @IsString()
  sortBy?: string = 'progress';

  @ApiProperty({
    description: 'Sort order',
    example: 'desc',
    type: 'string',
    required: false,
    enum: ['asc', 'desc'],
    default: 'desc'
  })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderBy?: string = 'desc';

  @ApiProperty({
    description: 'Filter by course tracking status',
    example: 'completed',
    type: 'string',
    required: false,
    enum: TrackingStatus
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(TrackingStatus))
  status?: TrackingStatus;

  @ApiProperty({
    description: 'Filter by enrollment status',
    example: 'published',
    type: 'string',
    required: false,
    enum: EnrollmentStatus
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(EnrollmentStatus))
  enrollmentStatus?: EnrollmentStatus;

  @ApiProperty({
    description: 'Filter by certificate issued status',
    example: true,
    type: 'boolean',
    required: false
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  certificateIssued?: boolean;
} 