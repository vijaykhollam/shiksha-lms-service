import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Course } from '../../courses/entities/course.entity';

export class UsersEnrolledCoursesDto {
  @ApiPropertyOptional({ description: 'Filter by cohort ID' })
  @IsOptional()
  @IsString()
  cohortId?: string;

  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter by pathway ID' })
  @IsOptional()
  @IsString()
  pathwayId?: string;


  @ApiPropertyOptional({ description: 'Limit', example: 10, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;
  
  @ApiPropertyOptional({ description: 'Offset', example: 0, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}

export class UsersEnrolledCoursesResponseDto {
  @ApiProperty({ description: 'List of enrolled courses matching the search criteria', type: [Course] })
  courses: Course[];

  @ApiProperty({ description: 'Total number of enrolled courses matching the criteria', example: 1 })
  @IsNumber()
  totalElements: number;

  @ApiProperty({ description: 'Number of items skipped (offset)', example: 0 })
  @IsNumber()
  offset: number;

  @ApiProperty({ description: 'Number of items returned (limit)', example: 10 })
  @IsNumber()
  limit: number;
} 